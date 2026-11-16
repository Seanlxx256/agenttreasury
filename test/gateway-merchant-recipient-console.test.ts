import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { seedGateway } from '../src/seed.js';

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

test('merchant payout address changes flow through the finance console', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agmrc-'));
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
  const financeToken = randomUUID();
  const operationsToken = randomUUID();
  const app = buildApp(pool, false, undefined, financeToken, false, operationsToken);
  t.after(async () => {
    try {
      await app.close();
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

  const payer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const recipient = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const seeded = await seedGateway(pool, { origin: 'http://127.0.0.1:3002', payer, recipient });
  const merchantId = seeded.merchantId;
  const next = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const operations = { authorization: `Bearer ${operationsToken}` };
  const finance = { authorization: `Bearer ${financeToken}` };

  await t.test('requesting a change stages it without moving the live recipient', async () => {
    const response = await app.inject({
      method: 'POST', url: `/finance/merchants/${merchantId}/recipient-change`,
      headers: operations, payload: { recipient: next },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.recipient, recipient);
    assert.equal(body.pendingRecipient, next);
    assert.equal(body.pendingRecipientRequestedBy, 'operations');
  });

  await t.test('confirmation requires the finance role', async () => {
    const denied = await app.inject({
      method: 'POST', url: `/finance/merchants/${merchantId}/recipient-change/confirm`,
      headers: operations,
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().code, 'FINANCE_ROLE_REQUIRED');
  });

  await t.test('finance confirmation moves the live recipient and clears the pending state', async () => {
    const response = await app.inject({
      method: 'POST', url: `/finance/merchants/${merchantId}/recipient-change/confirm`,
      headers: finance,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.recipient, next);
    assert.equal(body.pendingRecipient, null);

    const { rows: audits } = await pool.query(
      `SELECT action, actor, state_before AS "stateBefore", state_after AS "stateAfter"
       FROM audit_history WHERE entity = $1 ORDER BY id`,
      [`gateway_merchant:${merchantId}`]);
    assert.deepEqual(audits.map((row: { action: string }) => row.action),
      ['gateway.merchant.recipient-change.requested', 'gateway.merchant.recipient-change.confirmed']);
    assert.equal(audits[0].stateBefore, recipient);
    assert.equal(audits[0].stateAfter, next);
    assert.equal(audits[1].stateBefore, recipient);
    assert.equal(audits[1].stateAfter, next);
  });
});
