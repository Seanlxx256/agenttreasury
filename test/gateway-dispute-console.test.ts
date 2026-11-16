import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { traceDeliveryCommitment } from '../src/delivery-commitment.js';

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

test('disputes reach the console and commitment violations reach the review queue', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agdsp-'));
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
  const agentAuth = { authorization: `Bearer ${seeded.token}` };
  const financeAuth = { authorization: `Bearer ${financeToken}` };

  const makePurchase = async (options?: {
    charged?: boolean; delivered?: boolean; commitmentViolated?: boolean;
  }) => {
    const requestId = randomUUID();
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const batchHash = `0x${randomBytes(32).toString('hex')}`;
    await pool.query(`
      INSERT INTO gateway_demo_purchases
        (request_id, endpoint, nonce, payer, recipient, amount_units, task_id, budget_day,
         budget_status, submitted_at, delivery, delivery_commitment, commitment_satisfied, commitment_violations)
      VALUES ($1, $2, $3, $4, $5, 1000, $6, '2026-01-01', 'spent', now(), $7, $8, $9, $10)
    `, [requestId, `http://127.0.0.1:3002/trace/${requestId}`, nonce, payer, recipient, seeded.taskId,
        options?.delivered ? JSON.stringify({ requestId, nonce, gatewayReference: 'ref-1', trace: { source: 'fixture' } }) : null,
        options?.commitmentViolated ? JSON.stringify(traceDeliveryCommitment) : null,
        options?.commitmentViolated ? false : null,
        options?.commitmentViolated ? JSON.stringify(['trace.calls[0] type WRONG_TYPE != CALL']) : null]);
    if (options?.charged) {
      await pool.query(`
        INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
        VALUES ($1, $2, $3, 1000)
      `, [requestId, randomUUID(), batchHash]);
    }
    return { requestId };
  };

  await t.test('agent raises and finance arbitrates a refund through the HTTP entry points', async () => {
    const purchase = await makePurchase({ charged: true, delivered: true });

    const raised = await app.inject({
      method: 'POST', url: `/gateway-purchases/${purchase.requestId}/dispute`,
      headers: agentAuth, payload: { reason: 'bad content', evidence: { claim: 'delivery-content-mismatch' } },
    });
    assert.equal(raised.statusCode, 200);
    assert.equal(raised.json().status, 'OPEN');

    const decided = await app.inject({
      method: 'POST', url: `/finance/gateway-purchases/${purchase.requestId}/dispute-decision`,
      headers: financeAuth, payload: { decision: 'REFUND' },
    });
    assert.equal(decided.statusCode, 200);
    assert.equal(decided.json().status, 'REFUND_APPROVED');
  });

  await t.test('arbitration through the console requires the finance role', async () => {
    const purchase = await makePurchase({ charged: true, delivered: true });
    await app.inject({
      method: 'POST', url: `/gateway-purchases/${purchase.requestId}/dispute`,
      headers: agentAuth, payload: { reason: 'bad content', evidence: { claim: 'mismatch' } },
    });

    const denied = await app.inject({
      method: 'POST', url: `/finance/gateway-purchases/${purchase.requestId}/dispute-decision`,
      headers: { authorization: `Bearer ${operationsToken}` }, payload: { decision: 'REFUND' },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().code, 'FINANCE_ROLE_REQUIRED');
  });

  await t.test('a delivered purchase violating its commitment surfaces in the review queue', async () => {
    const purchase = await makePurchase({ charged: true, delivered: true, commitmentViolated: true });

    const queue = await app.inject({
      method: 'GET', url: '/finance/gateway-purchases/review-queue',
      headers: financeAuth,
    });
    assert.equal(queue.statusCode, 200);
    const row = queue.json().find((entry: { id: string; reason: string }) => entry.id === purchase.requestId);
    assert.ok(row);
    assert.equal(row.reason, 'delivery-commitment-violated');
  });
});
