// Explicit opt-in suite: runs against a disposable Redis, never a payment provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createClient } from 'redis';
import { createConnection, createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { OperationsCache, RedisMetricsStore } from '../src/operations-cache.js';

test('real Redis: shared cache, TTL, deletion, and closed-client fallback', async (t) => {
  const url = process.env.REDIS_TEST_URL;
  assert.ok(url, 'Set REDIS_TEST_URL to a disposable Redis instance');
  const namespace = `integration-${randomUUID()}`;
  const key = `agenttreasury:${namespace}:operations-metrics:v1`;
  const inspect = createClient({ url, socket: { connectTimeout: 1000, reconnectStrategy: false } });
  inspect.on('error', () => {});
  const storeA = new RedisMetricsStore(url, 1000);
  const storeB = new RedisMetricsStore(url, 1000);
  const first = new OperationsCache(storeA, namespace, 300);
  const second = new OperationsCache(storeB, namespace, 300);
  t.after(async () => { first.close(); second.close(); if (inspect.isOpen) { await inspect.del(key); inspect.destroy(); } });
  await inspect.connect(); let queries = 0;
  const load = async () => { queries++; return { observedAt: new Date().toISOString(), cases: { open: 1 },
    recovery: {}, scans: {}, latestRecoveryEvidence: {}, wallets: [], workers: [] }; };
  await first.read(load);
  assert.ok((await inspect.pTTL(key)) > 0);
  assert.equal(((await second.read(load)).cache as { source: string }).source, 'redis');
  assert.equal(queries, 1);
  await new Promise((r) => setTimeout(r, 320));
  await second.read(load); assert.equal(queries, 2);
  await inspect.del(key); await first.read(load); assert.equal(queries, 3);
  // A closed cache connection must degrade to DB without affecting the endpoint.
  storeA.close();
  assert.equal(((await first.read(load)).cache as { source: string }).source, 'database-fallback');
  assert.equal(queries, 4);
});

test('real Redis + PostgreSQL API: network loss falls back, fresh DB evidence survives, reconnect restores hits', { timeout: 30000 }, async (t) => {
  const target = new URL(process.env.REDIS_TEST_URL!);
  assert.equal(target.protocol, 'redis:', 'Network fault drill needs a disposable plaintext loopback Redis');
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
  const sockets = new Set<Socket>();
  const proxy = createServer((incoming) => {
    const outgoing = createConnection({ host: target.hostname, port: Number(target.port || 6379) });
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => { incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing); outgoing.pipe(incoming);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const address = proxy.address(); assert.ok(address && typeof address !== 'string');
  const proxyUrl = new URL(target); proxyUrl.hostname = '127.0.0.1'; proxyUrl.port = String(address.port);
  const directory = await mkdtemp(join(tmpdir(), 'ag-redis-pg-'));
  const portProbe = createServer();
  await new Promise<void>((r) => portProbe.listen(0, '127.0.0.1', r));
  const dbAddress = portProbe.address(); assert.ok(dbAddress && typeof dbAddress !== 'string');
  await new Promise<void>((r) => portProbe.close(() => r()));
  const password = randomUUID();
  const database = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), port: dbAddress.port, password,
    persistent: true, onLog() {}, onError() {}, postgresFlags: ['-h', '127.0.0.1', '-k', directory] });
  const pool = new Pool({ host: '127.0.0.1', port: dbAddress.port, user: 'postgres', database: 'postgres', password });
  const cache = new OperationsCache(new RedisMetricsStore(proxyUrl.href), `api-${randomUUID()}`);
  const app = buildApp(pool, false, undefined, 'finance', false, 'operations', cache);
  let started = false;
  t.after(async () => {
    await app.close(); await pool.end(); if (started) await database.stop();
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) await new Promise<void>((r) => proxy.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  });
  await database.initialise(); await database.start(); started = true; await migrate(pool);
  async function read() {
    const result = await app.inject({ url: '/finance/operations/metrics', headers: { authorization: 'Bearer operations' } });
    assert.equal(result.statusCode, 200); return result.json();
  }
  assert.equal((await read()).cache.source, 'database');
  assert.equal((await read()).cache.source, 'redis');
  await pool.query("INSERT INTO gateway_worker_health(worker) VALUES ('redis-fault-drill')");
  assert.equal((await read()).workers.length, 0); // Explicit, bounded dashboard staleness.
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((r) => proxy.close(() => r()));
  const fallback = await read(); assert.equal(fallback.cache.source, 'database-fallback');
  assert.equal(fallback.workers[0].worker, 'redis-fault-drill');
  assert.equal((await app.inject('/health/ready')).statusCode, 200);
  await new Promise<void>((r) => proxy.listen(address.port, '127.0.0.1', r));
  await new Promise((r) => setTimeout(r, 5100));
  assert.equal((await read()).cache.source, 'database');
  assert.equal((await read()).cache.source, 'redis');
});
