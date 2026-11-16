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
import { resolveRefundTransaction } from '../src/gateway-refund-send.js';
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

test('commitment violation flows through dispute, approval, refund and reconciliation', { timeout: 30_000 }, async (t) => {
  // The temp-dir prefix stays short: embedded-postgres puts its unix socket under
  // this directory, and macOS rejects socket paths longer than 103 bytes.
  const directory = await mkdtemp(join(tmpdir(), 'agdrf-'));
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

  // A charged payment whose delivery violates the merchant's commitment.
  const requestId = randomUUID();
  const nonce = `0x${randomBytes(32).toString('hex')}`;
  const batchHash = `0x${randomBytes(32).toString('hex')}` as Hash;
  const reason = 'dispute upheld';
  await pool.query(`
    INSERT INTO gateway_demo_purchases
      (request_id, endpoint, nonce, payer, recipient, amount_units, task_id, budget_day,
       budget_status, submitted_at, delivery, delivery_commitment, commitment_satisfied, commitment_violations)
    VALUES ($1, $2, $3, $4, $5, 1000, $6, '2026-01-01', 'spent', now(), $7, $8, false, $9)
  `, [requestId, `http://127.0.0.1:3002/trace/${requestId}`, nonce, payer, recipient, seeded.taskId,
      JSON.stringify({ requestId, nonce, gatewayReference: 'ref-1' }),
      JSON.stringify(traceDeliveryCommitment),
      JSON.stringify(['trace.calls[0] errored: execution reverted'])]);
  await pool.query(`
    INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
    VALUES ($1, $2, $3, 1000)
  `, [requestId, randomUUID(), batchHash]);

  // 1. The objective assessment is snapshotted onto the dispute at raise time.
  const raised = await raiseGatewayDeliveryDispute(pool, requestId, seeded.agentId, reason,
    { claim: 'delivery-content-mismatch' });
  assert.equal(raised.status, 'OPEN');
  assert.equal(raised.deliveryAssessment?.satisfied, false);
  assert.deepEqual(raised.deliveryAssessment?.violations, ['trace.calls[0] errored: execution reverted']);

  // 2. A human arbitrates a refund.
  const decided = await decideGatewayDeliveryDispute(pool, requestId, 'REFUND');
  assert.equal(decided.status, 'REFUNDED');
  assert.equal(decided.decidedBy, 'finance-operator');

  // 3. The refund now executes through the normal broadcast entry point, which
  //    recognizes the dispute's REFUNDED approval (not only a refund request).
  const refundHash = `0x${'c'.repeat(64)}` as Hash;
  const lock = await pool.connect();
  let broadcasts = 0;
  let resolved: Hash;
  try {
    resolved = await resolveRefundTransaction(lock, requestId, reason, async () => {
      broadcasts++;
      return refundHash;
    });
  } finally {
    lock.release();
  }
  assert.equal(broadcasts, 1);
  assert.equal(resolved, refundHash);

  // 4. The onchain evidence is recorded through the evidence path.
  const chain: GatewayRefundChain = {
    async finalized() { return 300n; },
    async blockHash(block) { return hashFor(block); },
    async receipt(hash) {
      if (hash === batchHash) {
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
  const recorded = await recordGatewayRefund(pool, chain, requestId, refundHash, 5, reason);
  assert.equal(recorded.requestId, requestId);
  assert.equal(recorded.transactionHash, refundHash);

  // 5. The refund lands in the correct account, and the audit trail is intact.
  const { rows: journal } = await pool.query(
    'SELECT account, side FROM gateway_refund_journal_lines WHERE request_id = $1 ORDER BY number', [requestId]);
  assert.deepEqual(journal.map((row) => [row.account, row.side]), [
    ['USDC_WALLET_ASSET', 'DEBIT'],
    ['DATA_PROCUREMENT_EXPENSE', 'CREDIT'],
  ]);

  const { rows: audit } = await pool.query(
    'SELECT action FROM audit_history WHERE entity = $1 ORDER BY id', [`gateway_delivery_dispute:${requestId}`]);
  assert.deepEqual(audit.map((row) => row.action), ['gateway.dispute.raised', 'gateway.dispute.decided']);
});
