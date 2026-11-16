import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import type { Hash } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { migrate } from '../src/migrate.js';
import { seedGateway } from '../src/seed.js';
import { decideGatewayRefund, requestGatewayRefund } from '../src/gateway-refund-requests.js';
import { resolveRefundTransaction } from '../src/gateway-refund-send.js';

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

const refundHash = () => `0x${randomBytes(32).toString('hex')}` as Hash;

test('gateway refund broadcast never repeats across a crash', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenttreasury-refund-send-'));
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

  const payer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const recipient = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const seeded = await seedGateway(pool, { origin: 'http://127.0.0.1:3002', payer, recipient });

  // A charged payment with no delivery, then a finance approval for the refund.
  const makeApprovedRefund = async (reason: string) => {
    const requestId = randomUUID();
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    await pool.query(`
      INSERT INTO gateway_demo_purchases
        (request_id, endpoint, nonce, payer, recipient, amount_units, task_id, budget_day, budget_status, submitted_at)
      VALUES ($1, $2, $3, $4, $5, 1000, $6, '2026-01-01', 'spent', now())
    `, [requestId, `http://127.0.0.1:3002/trace/${requestId}`, nonce, payer, recipient, seeded.taskId]);
    await pool.query(`
      INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
      VALUES ($1, $2, $3, 1000)
    `, [requestId, randomUUID(), `0x${randomBytes(32).toString('hex')}`]);
    await requestGatewayRefund(pool, requestId, seeded.agentId, reason);
    await decideGatewayRefund(pool, requestId, 'APPROVED');
    return requestId;
  };

  // The refund command runs on an autocommit connection, so the intent row commits
  // even when the broadcast then throws. Mirror that here rather than wrapping in
  // a transaction that would roll the intent back.
  const resolve = async (requestId: string, reason: string, write: () => Promise<Hash>) => {
    const client = await pool.connect();
    try {
      return await resolveRefundTransaction(client, requestId, reason, write);
    } finally {
      client.release();
    }
  };

  await t.test('a first submission broadcasts exactly once and persists the hash', async () => {
    const requestId = await makeApprovedRefund('delivery never arrived');
    let broadcasts = 0;
    const hash = refundHash();
    const resolved = await resolve(requestId, 'delivery never arrived', async () => {
      broadcasts++;
      return hash;
    });
    assert.equal(resolved, hash);
    assert.equal(broadcasts, 1);
    const { rows: [row] } = await pool.query(
      'SELECT transaction_hash AS "transactionHash", status FROM gateway_refund_authorizations WHERE request_id = $1', [requestId]);
    assert.equal(row.transactionHash, hash);
    assert.equal(row.status, 'submitted');
  });

  await t.test('a broadcast failure leaves an unresolved intent and never re-broadcasts', async () => {
    const requestId = await makeApprovedRefund('delivery never arrived');
    await assert.rejects(
      resolve(requestId, 'delivery never arrived', async () => {
        throw new Error('rpc down');
      }),
      (error: Error) => error.message.includes('failed or its result is unknown'),
    );
    const { rows: [row] } = await pool.query('SELECT status FROM gateway_refund_authorizations WHERE request_id = $1', [requestId]);
    assert.equal(row.status, 'submitting');

    let broadcasts = 0;
    await assert.rejects(
      resolve(requestId, 'delivery never arrived', async () => {
        broadcasts++;
        return refundHash();
      }),
      (error: Error) => error.message.includes('unresolved'),
    );
    assert.equal(broadcasts, 0);
  });

  await t.test('a crash after broadcast but before the hash is saved never re-broadcasts', async () => {
    const requestId = await makeApprovedRefund('delivery never arrived');
    // Simulate the crash window: the intent was persisted, the hash was not.
    await pool.query(
      "INSERT INTO gateway_refund_authorizations (request_id, reason, status) VALUES ($1, $2, 'submitting')",
      [requestId, 'delivery never arrived'],
    );
    let broadcasts = 0;
    await assert.rejects(
      resolve(requestId, 'delivery never arrived', async () => {
        broadcasts++;
        return refundHash();
      }),
      (error: Error) => error.message.includes('unresolved'),
    );
    assert.equal(broadcasts, 0);
  });
});
