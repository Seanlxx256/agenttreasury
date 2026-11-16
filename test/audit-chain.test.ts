import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { migrate } from '../src/migrate.js';
import { recordAudit, verifyAuditChain } from '../src/audit.js';
import { transaction } from '../src/db.js';

async function availablePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('audit history forms a tamper-evident hash chain', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenttreasury-audit-chain-'));
  const port = await availablePort();
  const password = randomUUID();
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'data'),
    port,
    password,
    persistent: true,
    onLog: () => {},
    onError: (message) => t.diagnostic(String(message)),
    postgresFlags: ['-h', '127.0.0.1', '-k', directory],
  });
  let started = false;
  const pool = new Pool({ host: '127.0.0.1', port, database: 'postgres', user: 'postgres', password });
  t.after(async () => {
    try {
      await pool.end();
      if (started) await postgres.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await postgres.initialise();
  await postgres.start();
  started = true;
  await migrate(pool);

  const write = (actor: string, action: string, entity: string) =>
    transaction(pool, (client) => recordAudit(client, {
      actor, action, entity, stateBefore: 'A', stateAfter: 'B',
    }));

  const seed = async (count: number) => {
    await pool.query('TRUNCATE audit_history RESTART IDENTITY');
    for (let i = 0; i < count; i++) {
      await write(`actor-${i}`, 'seed.audit', `entity:${i}`);
    }
  };

  await t.test('recomputes a valid chain end to end', async () => {
    await seed(3);
    const result = await verifyAuditChain(pool);
    assert.equal(result.verified, true);
    assert.equal(result.entries, 3);
    assert.equal(result.firstBrokenId, null);
    assert.equal(result.reason, null);
  });

  await t.test('detects a single edited field', async () => {
    await seed(3);
    const { rows } = await pool.query('SELECT id FROM audit_history ORDER BY id');
    await pool.query('UPDATE audit_history SET state_after = $2 WHERE id = $1', [rows[1].id, 'TAMPERED']);
    const result = await verifyAuditChain(pool);
    assert.equal(result.verified, false);
    assert.equal(result.firstBrokenId, rows[1].id);
    assert.equal(result.reason, 'entry-hash-mismatch');
  });

  await t.test('detects a broken link between intact entries', async () => {
    await seed(3);
    const { rows } = await pool.query('SELECT id FROM audit_history ORDER BY id');
    // Re-point the last row's prev_hash away from the previous row's hash,
    // simulating a removed middle row while every entry_hash stays intact.
    await pool.query('UPDATE audit_history SET prev_hash = $2 WHERE id = $1', [rows[2].id, 'deadbeef']);
    const result = await verifyAuditChain(pool);
    assert.equal(result.verified, false);
    assert.equal(result.firstBrokenId, rows[2].id);
    assert.equal(result.reason, 'prev-hash-mismatch');
  });

  await t.test('concurrent writers produce one unbroken chain', async () => {
    await pool.query('TRUNCATE audit_history RESTART IDENTITY');
    const writes = Array.from({ length: 6 }, (_, i) =>
      transaction(pool, (client) => recordAudit(client, {
        actor: `actor-${i}`, action: 'concurrent.audit', entity: `entity:${i}`, stateAfter: 'done',
      })));
    await Promise.all(writes);
    const result = await verifyAuditChain(pool);
    assert.equal(result.verified, true);
    assert.equal(result.entries, 6);
    const prevs = await pool.query('SELECT prev_hash AS "prevHash" FROM audit_history WHERE entry_hash IS NOT NULL ORDER BY id');
    const hashes = await pool.query('SELECT entry_hash AS "entryHash" FROM audit_history WHERE entry_hash IS NOT NULL ORDER BY id');
    assert.equal(prevs.rows[0]?.prevHash, null);
    for (let i = 1; i < hashes.rows.length; i++) {
      assert.equal(prevs.rows[i]?.prevHash, hashes.rows[i - 1]?.entryHash);
    }
  });
});
