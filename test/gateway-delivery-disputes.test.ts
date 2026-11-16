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
import { decideGatewayDeliveryDispute, raiseGatewayDeliveryDispute } from '../src/gateway-delivery-disputes.js';
import { recordGatewayRefund, type GatewayRefundChain } from '../src/gateway-refunds.js';
import { traceDeliveryCommitment } from '../src/delivery-commitment.js';
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

test('Gateway delivery dispute is arbitrated by a human and refunds through the evidence path', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenttreasury-gateway-dispute-'));
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

  const makePurchase = async (options?: {
    charged?: boolean; delivered?: boolean;
    commitment?: { deliveryCommitment: unknown; satisfied: boolean; violations: string[] };
  }) => {
    const requestId = randomUUID();
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const batchHash = `0x${randomBytes(32).toString('hex')}`;
    const commitment = options?.commitment;
    await pool.query(`
      INSERT INTO gateway_demo_purchases
        (request_id, endpoint, nonce, payer, recipient, amount_units, task_id, budget_day,
         budget_status, submitted_at, delivery, delivery_commitment, commitment_satisfied, commitment_violations)
      VALUES ($1, $2, $3, $4, $5, 1000, $6, '2026-01-01', 'spent', now(), $7, $8, $9, $10)
    `, [requestId, `http://127.0.0.1:3002/trace/${requestId}`, nonce, payer, recipient, seeded.taskId,
        options?.delivered ? JSON.stringify({ requestId, nonce, gatewayReference: 'ref-1', trace: { source: 'fixture' } }) : null,
        commitment ? JSON.stringify(commitment.deliveryCommitment) : null,
        commitment ? commitment.satisfied : null,
        commitment ? JSON.stringify(commitment.violations) : null]);
    if (options?.charged) {
      await pool.query(`
        INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
        VALUES ($1, $2, $3, 1000)
      `, [requestId, randomUUID(), batchHash]);
    }
    return { requestId, batchHash };
  };

  const evidence = { claim: 'delivery-content-mismatch', expected: 'trace for request', received: 'empty trace' };

  await t.test('dispute requires a charged payment that was actually delivered', async () => {
    const uncharged = await makePurchase({ delivered: true });
    await assert.rejects(raiseGatewayDeliveryDispute(pool, uncharged.requestId, seeded.agentId, 'bad content', evidence),
      (error: Error & { code?: string }) => error.code === 'PAYMENT_NOT_CHARGED');

    const undelivered = await makePurchase({ charged: true });
    await assert.rejects(raiseGatewayDeliveryDispute(pool, undelivered.requestId, seeded.agentId, 'bad content', evidence),
      (error: Error & { code?: string }) => error.code === 'DELIVERY_MISSING_USE_REFUND');

    await assert.rejects(raiseGatewayDeliveryDispute(pool, randomUUID(), seeded.agentId, 'bad content', evidence),
      (error: Error & { code?: string }) => error.code === 'GATEWAY_PURCHASE_NOT_FOUND');

    await assert.rejects(raiseGatewayDeliveryDispute(pool, undelivered.requestId, seeded.agentId, 'bad content', 'not an object'),
      (error: Error & { code?: string }) => error.code === 'INVALID_DISPUTE_EVIDENCE');
  });

  await t.test('raising is idempotent for the same claim and rejects a changed claim', async () => {
    const purchase = await makePurchase({ charged: true, delivered: true });
    const raised = await raiseGatewayDeliveryDispute(pool, purchase.requestId, seeded.agentId, 'bad content', evidence);
    assert.equal(raised.status, 'OPEN');
    assert.equal(raised.raisedBy, seeded.agentId);
    assert.deepEqual(raised.evidence, evidence);

    assert.equal((await raiseGatewayDeliveryDispute(pool, purchase.requestId, seeded.agentId, 'bad content', evidence)).status,
      'OPEN');
    await assert.rejects(raiseGatewayDeliveryDispute(pool, purchase.requestId, seeded.agentId, 'different claim', evidence),
      (error: Error & { code?: string }) => error.code === 'DISPUTE_EXISTS');
    await assert.rejects(raiseGatewayDeliveryDispute(pool, purchase.requestId, seeded.agentId, 'bad content', { ...evidence, extra: true }),
      (error: Error & { code?: string }) => error.code === 'DISPUTE_EXISTS');
  });

  await t.test('arbitration decides once and cannot be replayed', async () => {
    const refunded = await makePurchase({ charged: true, delivered: true });
    await raiseGatewayDeliveryDispute(pool, refunded.requestId, seeded.agentId, 'bad content', evidence);
    const decided = await decideGatewayDeliveryDispute(pool, refunded.requestId, 'REFUND');
    assert.equal(decided.status, 'REFUND_APPROVED');
    assert.equal(decided.decidedBy, 'finance-operator');
    await assert.rejects(decideGatewayDeliveryDispute(pool, refunded.requestId, 'DISMISS'),
      (error: Error & { code?: string }) => error.code === 'DISPUTE_ALREADY_DECIDED');

    const dismissed = await makePurchase({ charged: true, delivered: true });
    await raiseGatewayDeliveryDispute(pool, dismissed.requestId, seeded.agentId, 'bad content', evidence);
    assert.equal((await decideGatewayDeliveryDispute(pool, dismissed.requestId, 'DISMISS')).status, 'DISMISSED');
    await assert.rejects(decideGatewayDeliveryDispute(pool, dismissed.requestId, 'REFUND'),
      (error: Error & { code?: string }) => error.code === 'DISPUTE_ALREADY_DECIDED');

    await assert.rejects(decideGatewayDeliveryDispute(pool, randomUUID(), 'REFUND'),
      (error: Error & { code?: string }) => error.code === 'DISPUTE_NOT_FOUND');
  });

  await t.test('a REFUND arbitration flows through the existing onchain evidence path', async () => {
    const purchase = await makePurchase({ charged: true, delivered: true });
    await raiseGatewayDeliveryDispute(pool, purchase.requestId, seeded.agentId, 'bad content', evidence);
    assert.equal((await decideGatewayDeliveryDispute(pool, purchase.requestId, 'REFUND')).status, 'REFUND_APPROVED');

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

    const recorded = await recordGatewayRefund(pool, chain, purchase.requestId, refundHash, 5, 'dispute upheld');
    assert.equal(recorded.requestId, purchase.requestId);
    assert.equal(recorded.transactionHash, refundHash);
    assert.equal(recorded.reason, 'dispute upheld');

    const { rows: [finished] } = await pool.query(
      'SELECT status FROM gateway_delivery_disputes WHERE request_id = $1', [purchase.requestId]);
    assert.equal(finished.status, 'REFUNDED');
  });

  await t.test('raise snapshots the objective delivery commitment assessment', async () => {
    const purchase = await makePurchase({
      charged: true, delivered: true,
      commitment: {
        deliveryCommitment: traceDeliveryCommitment,
        satisfied: false,
        violations: ['trace.calls[0] errored: execution reverted'],
      },
    });
    const raised = await raiseGatewayDeliveryDispute(pool, purchase.requestId, seeded.agentId, 'bad content', evidence);
    assert.equal(raised.deliveryAssessment?.satisfied, false);
    assert.deepEqual(raised.deliveryAssessment?.violations, ['trace.calls[0] errored: execution reverted']);
    assert.deepEqual(raised.deliveryAssessment?.commitment, traceDeliveryCommitment);
    // The buyer's subjective claim stays untouched; the objective assessment sits alongside it.
    assert.deepEqual(raised.evidence, evidence);
  });
});
