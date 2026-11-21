import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { OperationsCache, RedisMetricsStore, operationsCacheFromEnv, type MetricsStore } from '../src/operations-cache.js';

const snapshot = () => ({ observedAt: new Date().toISOString(), cases: { open: 1 },
  recovery: { reserved: 2 }, scans: { failed: 0 }, latestRecoveryEvidence: { conflict: 0 }, wallets: [], workers: [] });
class MemoryStore implements MetricsStore {
  values = new Map<string, string>();
  reads = 0; writes = 0; closed = false; ttl = 0;
  async get(key: string) { this.reads++; return this.values.get(key) ?? null; }
  async set(key: string, value: string, ttl: number) { this.writes++; this.ttl = ttl; this.values.set(key, value); }
  close() { this.closed = true; }
}

test('metrics cache reduces 20 sequential aggregate reads to one; expiry loads fresh data', async () => {
  const store = new MemoryStore(); let now = 1000; let queries = 0;
  const cache = new OperationsCache(store, 'test', 5000, () => now);
  const load = async () => { queries++; return snapshot(); };
  assert.deepEqual((await cache.read(load)).cache, { source: 'database', ageMs: 0, ttlMs: 5000 });
  assert.equal(queries, 1);
  now += 200;
  for (let i = 0; i < 19; i++) assert.deepEqual((await cache.read(load)).cache, { source: 'redis', ageMs: 200, ttlMs: 5000 });
  assert.equal(queries, 1); assert.equal(store.writes, 1); assert.equal(store.ttl, 5000);
  now = 6000;
  await cache.read(load); assert.equal(queries, 2);
});

test('namespaces isolate deployments; corrupt, expired and future entries are not served', async () => {
  const store = new MemoryStore(); let queries = 0;
  const cache = new OperationsCache(store, 'a', 5000, () => 10000);
  const load = async () => { queries++; return snapshot(); };
  for (const raw of ['{', 'null', JSON.stringify({ version: 1, createdAt: 10000, data: {} }),
    JSON.stringify({ version: 1, createdAt: 5000, data: snapshot() }),
    JSON.stringify({ version: 1, createdAt: 10001, data: snapshot() })]) {
    store.values.set('agenttreasury:a:operations-metrics:v1', raw);
    await cache.read(load);
  }
  assert.equal(queries, 5);
  assert.equal(((await cache.read(load)).cache as { source: string }).source, 'redis');
  assert.equal(store.writes, 5);
  await new OperationsCache(store, 'b', 5000, () => 10000).read(load);
  assert.equal(queries, 6);
});

test('Redis read/write failure falls back; concurrent misses coalesce; DB failures remain errors', async () => {
  let queries = 0; let fail = true;
  const store = new MemoryStore();
  store.get = async () => { if (fail) throw new Error('offline'); return null; };
  store.set = async () => { throw new Error('write failed'); };
  const cache = new OperationsCache(store, 'test');
  const load = async () => { queries++; await new Promise((r) => setTimeout(r, 5)); return snapshot(); };
  const results = await Promise.all(Array.from({ length: 20 }, () => cache.read(load)));
  assert.equal(queries, 1);
  for (const result of results) assert.equal((result.cache as { source: string }).source, 'database-fallback');
  fail = false;
  assert.equal(((await cache.read(load)).cache as { source: string }).source, 'database-fallback');
  await assert.rejects(cache.read(async () => { throw new Error('database down'); }), /database down/);
  await cache.read(load); assert.equal(queries, 3);
});

test('slow database responses are never cached past the snapshot window', async () => {
  const store = new MemoryStore(); let now = 0;
  const cache = new OperationsCache(store, 'slow', 5000, () => now);
  await cache.read(async () => { now = 6000; return snapshot(); });
  assert.equal(store.writes, 0);
});

test('metrics route authenticates cache hits, marks responses no-store, and closes the client', async () => {
  const store = new MemoryStore(); let queries = 0;
  const pool = { query: async () => { queries++; return { rows: [snapshot()] }; } } as unknown as Pool;
  const cache = new OperationsCache(store, 'route');
  const app = buildApp(pool, false, undefined, 'finance-token', false, 'ops-token', cache);
  try {
    const url = '/finance/operations/metrics';
    assert.equal((await app.inject(url)).statusCode, 401); assert.equal(store.reads, 0);
    for (const token of ['ops-token', 'finance-token']) {
      const response = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(queries, 1);
    const reads = store.reads;
    assert.equal((await app.inject({ url, headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
    assert.equal(store.reads, reads);
    // Case details still read the database, even with a warm metrics cache.
    await app.inject({ url: '/finance/reconciliation-cases', headers: { authorization: 'Bearer ops-token' } });
    assert.equal(queries, 2);
  } finally { await app.close(); }
  assert.equal(store.closed, true);
});

test('Redis configuration is opt-in and requires deployment isolation', () => {
  assert.equal(operationsCacheFromEnv({}), undefined);
  assert.throws(() => operationsCacheFromEnv({ REDIS_URL: 'redis://127.0.0.1' }), /NAMESPACE/);
  assert.throws(() => operationsCacheFromEnv({ REDIS_URL: 'https://localhost', REDIS_CACHE_NAMESPACE: 'test' }), /redis:\/\//);
  assert.throws(() => operationsCacheFromEnv({ REDIS_URL: 'invalid-secret', REDIS_CACHE_NAMESPACE: 'test' }),
    (error: Error) => error.message === 'REDIS_URL must be a valid Redis connection URL');
  operationsCacheFromEnv({ REDIS_URL: 'redis://127.0.0.1', REDIS_CACHE_NAMESPACE: 'test' })!.close();
});

test('silent Redis TCP peer is bounded, connection is destroyed and circuit backs off', async (t) => {
  const sockets = new Set<import('node:net').Socket>(); let connections = 0;
  const server = createServer((socket) => { connections++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const store = new RedisMetricsStore(`redis://127.0.0.1:${address.port}`, 40);
  t.after(async () => { store.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>((r) => server.close(() => r())); });
  const start = Date.now();
  await assert.rejects(store.get('test'), /unavailable/);
  assert.ok(Date.now() - start < 1000);
  await assert.rejects(store.get('test'), /unavailable/);
  assert.equal(connections, 1);
});
