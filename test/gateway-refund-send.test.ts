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
import { recoverGatewayRefund, recoverGatewayRefundSubmission, resolveRefundTransaction } from '../src/gateway-refund-send.js';
import type { GatewayRefundChain } from '../src/gateway-refunds.js';
import { arcTestnetUsdc } from '../src/gateway-x402.js';

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

  await t.test('controlled recovery persists the onchain hash without broadcasting', async () => {
    const requestId = await makeApprovedRefund('delivery never arrived');
    await pool.query(
      "INSERT INTO gateway_refund_authorizations (request_id, reason, status) VALUES ($1, $2, 'submitting')",
      [requestId, 'delivery never arrived'],
    );
    const hash = refundHash();
    const client = await pool.connect();
    try {
      const recovered = await recoverGatewayRefundSubmission(client, requestId, hash, 'delivery never arrived');
      assert.equal(recovered, hash);
    } finally {
      client.release();
    }
    const { rows: [row] } = await pool.query(
      'SELECT transaction_hash AS "transactionHash", status FROM gateway_refund_authorizations WHERE request_id = $1', [requestId]);
    assert.equal(row.transactionHash, hash);
    assert.equal(row.status, 'submitted');

    // A wrong reason is rejected without touching the intent.
    const wrong = await makeApprovedRefund('wrong reason');
    await pool.query(
      "INSERT INTO gateway_refund_authorizations (request_id, reason, status) VALUES ($1, $2, 'submitting')",
      [wrong, 'wrong reason'],
    );
    await assert.rejects(
      (async () => {
        const c = await pool.connect();
        try { await recoverGatewayRefundSubmission(c, wrong, refundHash(), 'different reason'); }
        finally { c.release(); }
      })(),
      (error: Error) => error.message.includes('original refund reason'),
    );

    // A second recovery of the already-resolved row is rejected.
    await assert.rejects(
      (async () => {
        const c = await pool.connect();
        try { await recoverGatewayRefundSubmission(c, requestId, refundHash(), 'delivery never arrived'); }
        finally { c.release(); }
      })(),
      (error: Error) => error.message.includes('already resolved'),
    );
  });

  await t.test('recovery rejects a stale refund hash before committing any state', async () => {
    const requestId = await makeApprovedRefund('delivery never arrived');
    await pool.query(
      "INSERT INTO gateway_refund_authorizations (request_id, reason, status) VALUES ($1, $2, 'submitting')",
      [requestId, 'delivery never arrived'],
    );

    const { rows: [payment] } = await pool.query<{ payer: string; recipient: string; batchHash: Hash; amount: string }>(`
      SELECT p.payer, p.recipient, j.batch_hash AS "batchHash", j.amount::text AS amount
      FROM gateway_payment_journal j JOIN gateway_demo_purchases p ON p.request_id = j.request_id
      WHERE j.request_id = $1
    `, [requestId]);
    assert.ok(payment);

    // The supplied hash is the right from/to/amount but belongs to an OLDER
    // transaction than the original batch, so the full check must reject it.
    const staleHash = refundHash();
    const blockHash = async (block: bigint) => `0x${block.toString(16).padStart(64, '0')}` as Hash;
    const chain: GatewayRefundChain = {
      async finalized() { return 1000n; },
      blockHash,
      async receipt(hash) {
        if (hash === staleHash) {
          return { blockNumber: 100n, blockHash: await blockHash(100n), transactionIndex: 0, status: 'success',
            logs: [{ address: arcTestnetUsdc, logIndex: 0, from: payment.recipient,
              to: payment.payer, amount: BigInt(payment.amount) }] };
        }
        if (hash === payment.batchHash) {
          return { blockNumber: 500n, blockHash: await blockHash(500n), transactionIndex: 0, status: 'success', logs: [] };
        }
        throw new Error('unexpected hash');
      },
    };

    await assert.rejects(
      recoverGatewayRefund(pool, chain, requestId, staleHash, 'delivery never arrived'),
      (error: Error & { code?: string }) => error.code === 'INVALID_REFUND_EVIDENCE',
    );

    // The intent is still retryable, not stuck in `submitted` with a bad hash.
    const { rows: [auth] } = await pool.query(
      'SELECT status, transaction_hash AS "transactionHash" FROM gateway_refund_authorizations WHERE request_id = $1', [requestId]);
    assert.equal(auth.status, 'submitting');
    assert.equal(auth.transactionHash, null);
  });
});
