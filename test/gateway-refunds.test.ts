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
import { recordGatewayRefund, type GatewayRefundChain } from '../src/gateway-refunds.js';
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

const hashFor = (block: bigint) => `0x${block.toString(16).padStart(64, '0')}` as Hash;

test('Gateway refund approval and onchain evidence', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenttreasury-gateway-refund-'));
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

  const makePurchase = async (options?: { charged?: boolean; delivered?: boolean }) => {
    const requestId = randomUUID();
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const batchHash = `0x${randomBytes(32).toString('hex')}`;
    await pool.query(`
      INSERT INTO gateway_demo_purchases
        (request_id, endpoint, nonce, payer, recipient, amount_units, task_id, budget_day,
         budget_status, submitted_at, delivery)
      VALUES ($1, $2, $3, $4, $5, 1000, $6, '2026-01-01', 'spent', now(), $7)
    `, [requestId, `http://127.0.0.1:3002/trace/${requestId}`, nonce, payer, recipient, seeded.taskId,
        options?.delivered ? JSON.stringify({ requestId }) : null]);
    if (options?.charged) {
      await pool.query(`
        INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
        VALUES ($1, $2, $3, 1000)
      `, [requestId, randomUUID(), batchHash]);
    }
    return { requestId, batchHash };
  };

  await t.test('refund request requires a charged payment with missing delivery', async () => {
    const uncharged = await makePurchase();
    await assert.rejects(requestGatewayRefund(pool, uncharged.requestId, seeded.agentId, 'delivery never arrived'),
      (error: Error & { code?: string }) => error.code === 'PAYMENT_NOT_CHARGED');

    const delivered = await makePurchase({ charged: true, delivered: true });
    await assert.rejects(requestGatewayRefund(pool, delivered.requestId, seeded.agentId, 'delivery never arrived'),
      (error: Error & { code?: string }) => error.code === 'PAYMENT_ALREADY_DELIVERED');

    await assert.rejects(requestGatewayRefund(pool, randomUUID(), seeded.agentId, 'unknown request'),
      (error: Error & { code?: string }) => error.code === 'GATEWAY_PURCHASE_NOT_FOUND');
  });

  await t.test('approval flow records PENDING then APPROVED, and rejects replay', async () => {
    const purchase = await makePurchase({ charged: true });
    const requested = await requestGatewayRefund(pool, purchase.requestId, seeded.agentId, 'no delivery');
    assert.equal(requested.status, 'PENDING');
    assert.equal(requested.requestedBy, seeded.agentId);

    // Idempotent with the same reason, rejected with a different one.
    assert.equal((await requestGatewayRefund(pool, purchase.requestId, seeded.agentId, 'no delivery')).status, 'PENDING');
    await assert.rejects(requestGatewayRefund(pool, purchase.requestId, seeded.agentId, 'changed mind'),
      (error: Error & { code?: string }) => error.code === 'REFUND_REQUEST_EXISTS');

    const approved = await decideGatewayRefund(pool, purchase.requestId, 'APPROVED');
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.decidedBy, 'finance-operator');
    await assert.rejects(decideGatewayRefund(pool, purchase.requestId, 'DENIED'),
      (error: Error & { code?: string }) => error.code === 'REFUND_ALREADY_DECIDED');

    // A DENIED request cannot be refunded.
    const denied = await makePurchase({ charged: true });
    await requestGatewayRefund(pool, denied.requestId, seeded.agentId, 'no delivery');
    await decideGatewayRefund(pool, denied.requestId, 'DENIED');
    await assert.rejects(decideGatewayRefund(pool, denied.requestId, 'APPROVED'),
      (error: Error & { code?: string }) => error.code === 'REFUND_ALREADY_DECIDED');
  });

  await t.test('recordGatewayRefund validates the refund transfer and posts it', async () => {
    const purchase = await makePurchase({ charged: true });
    const refundHash = `0x${'c'.repeat(64)}` as Hash;
    const chain: GatewayRefundChain = {
      async finalized() { return 300n; },
      async blockHash(block) { return hashFor(block); },
      async receipt(hash) {
        if (hash === (purchase.batchHash as Hash)) {
          return { blockNumber: 100n, blockHash: hashFor(100n), transactionIndex: 0, status: 'success', logs: [] };
        }
        if (hash === refundHash) {
          return {
            blockNumber: 200n, blockHash: hashFor(200n), transactionIndex: 1, status: 'success',
            logs: [{ address: arcTestnetUsdc, logIndex: 5, from: recipient, to: payer, amount: 1000n }],
          };
        }
        throw new Error(`unexpected hash ${hash}`);
      },
    };

    const recorded = await recordGatewayRefund(pool, chain, purchase.requestId, refundHash, 5, 'no delivery');
    assert.equal(recorded.requestId, purchase.requestId);
    assert.equal(recorded.transactionHash, refundHash);
    assert.equal(recorded.reason, 'no delivery');

    // Replaying the same evidence is idempotent; different evidence conflicts.
    assert.equal((await recordGatewayRefund(pool, chain, purchase.requestId, refundHash, 5, 'no delivery')).requestId,
      purchase.requestId);
    await assert.rejects(recordGatewayRefund(pool, chain, purchase.requestId, refundHash, 6, 'no delivery'),
      (error: Error & { code?: string }) => error.code === 'REFUND_ALREADY_RECORDED');
  });

  await t.test('recordGatewayRefund rejects wrong direction, amount, and order', async () => {
    const purchase = await makePurchase({ charged: true });
    const refundHash = `0x${'c'.repeat(64)}` as Hash;
    const makeChain = (logs: {
      address: string; logIndex: number; from: string; to: string; amount: bigint
    }[], refundBlock = 200n): GatewayRefundChain => {
      const chain: GatewayRefundChain = {
        async finalized() { return 300n; },
        async blockHash(block) { return hashFor(block); },
        async receipt(hash) {
          if (hash === (purchase.batchHash as Hash)) {
            return { blockNumber: 100n, blockHash: hashFor(100n), transactionIndex: 0, status: 'success', logs: [] };
          }
          if (hash === refundHash) {
            return { blockNumber: refundBlock, blockHash: hashFor(refundBlock), transactionIndex: 1, status: 'success', logs };
          }
          throw new Error(`unexpected hash ${hash}`);
        },
      };
      return chain;
    };

    const valid = { address: arcTestnetUsdc, logIndex: 5, from: recipient, to: payer, amount: 1000n };
    await assert.rejects(recordGatewayRefund(pool, makeChain([{ ...valid, from: payer, to: recipient }]),
      purchase.requestId, refundHash, 5, 'no delivery'),
      (error: Error & { code?: string }) => error.code === 'INVALID_REFUND_EVIDENCE');
    await assert.rejects(recordGatewayRefund(pool, makeChain([{ ...valid, amount: 999n }]),
      purchase.requestId, refundHash, 5, 'no delivery'),
      (error: Error & { code?: string }) => error.code === 'INVALID_REFUND_EVIDENCE');
    // Refund posted before the original batch.
    await assert.rejects(recordGatewayRefund(pool, makeChain([valid], 50n),
      purchase.requestId, refundHash, 5, 'no delivery'),
      (error: Error & { code?: string }) => error.code === 'INVALID_REFUND_EVIDENCE');
    // Refund not yet finalized.
    await assert.rejects(recordGatewayRefund(pool, makeChain([valid], 400n),
      purchase.requestId, refundHash, 5, 'no delivery'),
      (error: Error & { code?: string }) => error.code === 'REFUND_NOT_FINALIZED');
  });
});
