import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { seedGateway } from '../src/seed.js';
import { createInvestigationCheckpoint, resumeInvestigationCheckpoint } from '../src/gateway-investigation-checkpoints.js';
import { OperationsCache } from '../src/operations-cache.js';

test('investigation recovery dashboard reads live paginated evidence without financial mutation', { timeout: 60000 }, async (t) => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const dir = await mkdtemp(join(tmpdir(), 'ag-inv-queue-')), password = randomUUID();
  const postgres = new EmbeddedPostgres({ databaseDir: join(dir, 'db'), port: address.port, password, persistent: true,
    postgresFlags: ['-h', '127.0.0.1', '-k', dir], onLog: () => {}, onError: () => {} });
  const pool = new Pool({ host: '127.0.0.1', port: address.port, password, user: 'postgres', database: 'postgres' });
  const finance = randomBytes(32).toString('hex'), operations = randomBytes(32).toString('hex');
  let cacheCalls = 0, started = false;
  const cache = new OperationsCache({ get: async () => { cacheCalls++; return null; },
    set: async () => { cacheCalls++; }, close() {} }, 'queue-fixture');
  const app = buildApp(pool, false, undefined, finance, false, operations, cache);
  t.after(async () => { await app.close(); await pool.end(); if (started) await postgres.stop(); await rm(dir, { recursive: true, force: true }); });
  await postgres.initialise(); await postgres.start(); started = true; await migrate(pool);
  const payer = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, requestId = randomUUID();
  const seeded = await seedGateway(pool, { origin: 'https://merchant.example', payer, recipient });
  await pool.query(`INSERT INTO gateway_demo_purchases(request_id,endpoint,nonce,payer,recipient,amount_units,task_id,
    budget_day,budget_status,retrieval_token) VALUES($1,'https://merchant.example/trace',$2,$3,$4,1000,$5,current_date,'reserved','SECRET_RETRIEVAL')`,
  [requestId,`0x${'3'.repeat(64)}`,payer,recipient,seeded.taskId]);
  await pool.query(`INSERT INTO gateway_payment_journal(request_id,transfer_id,batch_hash,amount) VALUES($1,$2,$3,2000)`, [requestId,randomUUID(),`0x${'4'.repeat(64)}`]);
  await pool.query(`INSERT INTO gateway_payment_observations(request_id,source,evidence) VALUES($1,'worker','{"status":"conflict","reason":"accounting-mismatch"}')`, [requestId]);
  const headers = { authorization: `Bearer ${operations}` }, url = '/finance/operations/investigations';
  const get = (suffix = '') => app.inject({ url: url + suffix, headers });
  async function businessState() {
    const state: Record<string, unknown> = {};
    for (const table of ['gateway_demo_purchases','research_tasks','daily_spend','gateway_payment_journal',
      'gateway_payment_observations','gateway_payment_refunds','gateway_refund_requests','audit_history']) {
      state[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return state;
  }
  await t.test('queue requires operations/finance credentials and reports an empty backlog without fabricated ages', async () => {
    assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { authorization: `Bearer ${seeded.token}` } })).statusCode, 401);
    for (const token of [operations, finance]) {
      const response = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.json().summary, { unfinishedCount: 0, oldestCreatedAt: null, oldestAgeSeconds: null,
        longestSinceSaveSeconds: null, withoutSavedChecks: 0, savedTimeUnknown: 0 });
      assert.deepEqual(response.json().checkpoints, []); assert.equal(response.json().next, null);
      assert.equal(response.json().executionState, 'unknown');
    }
    assert.equal((await get('?after=not-a-uuid')).statusCode, 400);
    assert.equal((await get('?limit=500')).statusCode, 400);
    assert.equal((await get('?after=' + randomUUID())).json().code, 'INVALID_INVESTIGATION_CURSOR');
    assert.equal(cacheCalls, 0);
  });

  const firstId = await createInvestigationCheckpoint(pool, requestId, 'operations');
  const ids = [firstId, ...Array.from({ length: 52 }, () => randomUUID())].sort();
  await pool.query(`INSERT INTO gateway_investigation_checkpoints(id,request_id,actor,last_actor,model,refresh_external,snapshot,progress)
    SELECT clone.id,c.request_id,c.actor,c.last_actor,c.model,c.refresh_external,c.snapshot,c.progress
    FROM gateway_investigation_checkpoints c CROSS JOIN unnest($2::uuid[]) AS clone(id) WHERE c.id=$1`, [firstId,ids.filter((id) => id !== firstId)]);
  const created = new Date(Date.now() - 3600000).toISOString(), savedAt = new Date(Date.now() - 1800000).toISOString();
  await pool.query('UPDATE gateway_investigation_checkpoints SET created_at=$1', [created]);
  const finished = await resumeInvestigationCheckpoint(pool, requestId, ids[52]!, 'operations');
  const progress = { version: 1, required: finished.guided.required, checks: finished.guided.checks, turns: finished.guided.turns };
  // One legacy checkpoint has results but no exact save clock; another has a
  // measured save clock. Recent attempt activity must not replace either value.
  await pool.query('UPDATE gateway_investigation_checkpoints SET progress=$2,updated_at=now() WHERE id=ANY($1::uuid[])', [ids.slice(0, 2),JSON.stringify(progress)]);
  await pool.query('UPDATE gateway_investigation_checkpoints SET last_checkpoint_at=$2 WHERE id=$1', [ids[1],savedAt]);
  const before = await businessState();

  await t.test('summary and first page share a clock, exclude finished runs and preserve unknown historical save times', async () => {
    const response = await get(); assert.equal(response.statusCode, 200, response.body); const page = response.json();
    assert.equal(page.source, 'database'); assert.equal(page.summary.unfinishedCount, 52);
    assert.equal(page.summary.withoutSavedChecks, 50); assert.equal(page.summary.savedTimeUnknown, 1);
    assert.equal(Date.parse(page.summary.oldestCreatedAt), Date.parse(created));
    assert.ok(Math.abs(page.summary.oldestAgeSeconds - (Date.parse(page.observedAt) - Date.parse(created)) / 1000) < .01);
    assert.ok(Math.abs(page.summary.longestSinceSaveSeconds - (Date.parse(page.observedAt) - Date.parse(savedAt)) / 1000) < .01);
    assert.deepEqual(page.checkpoints.map((row: { id: string }) => row.id), ids.slice(0, 50)); assert.equal(page.next, ids[49]);
    assert.equal(page.checkpoints[0].lastSavedAt, null); assert.equal(page.checkpoints[0].sinceLastSaveSeconds, null);
    assert.ok(page.checkpoints[0].savedChecks > 0); assert.equal(page.checkpoints[1].savedChecks, progress.checks.length);
    assert.ok(!response.body.includes('SECRET_RETRIEVAL'));
    assert.ok(page.checkpoints.every((row: object) => !('progress' in row) && !('snapshot' in row)));
    assert.deepEqual(await businessState(), before);
  });
  await t.test('pagination survives a finished cursor row and live refresh removes completed investigations immediately', async () => {
    const response = await app.inject({ method: 'POST', url: `/finance/gateway-purchases/${requestId}/investigation/checkpoints/${ids[49]}/resume`, headers, payload: {} });
    assert.equal(response.statusCode, 200, response.body);
    const second = (await get('?after=' + ids[49])).json();
    assert.deepEqual(second.checkpoints.map((row: { id: string }) => row.id), ids.slice(50, 52));
    assert.equal(second.next, null); assert.equal(second.summary.unfinishedCount, 51);
    const refreshed = (await get()).json(); assert.equal(refreshed.summary.unfinishedCount, 51);
    assert.ok(!refreshed.checkpoints.some((row: { id: string }) => row.id === ids[49])); assert.equal(cacheCalls, 0);
    const { rows: [saved] } = await pool.query('SELECT last_checkpoint_at,created_at FROM gateway_investigation_checkpoints WHERE id=$1', [ids[49]]);
    assert.ok(saved.last_checkpoint_at instanceof Date); assert.ok(saved.last_checkpoint_at > saved.created_at);
    assert.deepEqual(await businessState(), before);
  });
  await t.test('live workers stay classified as unknown and the existing lock rejects concurrent manual recovery', async () => {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,90253))', [ids[2]]);
      const page = (await get()).json(); assert.equal(page.executionState, 'unknown');
      assert.ok(page.checkpoints.some((row: { id: string }) => row.id === ids[2]));
      const response = await app.inject({ method: 'POST', url: `/finance/gateway-purchases/${requestId}/investigation/checkpoints/${ids[2]}/resume`, headers, payload: {} });
      assert.equal(response.statusCode, 409); assert.equal(response.json().code, 'INVESTIGATION_BUSY');
      assert.equal((await get()).json().summary.unfinishedCount, 51); assert.deepEqual(await businessState(), before);
    } finally { client.release(true); }
  });
});
