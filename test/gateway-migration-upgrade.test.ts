import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';

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

// The migrations as they existed before the legacy-upgrade fixes: stop at 029 so
// the test can seed pre-fix data, then apply 030 and 031 on top.
const legacyFiles = ['001_init.sql', '002_quote_worker.sql', '003_settlement.sql', '004_payment_ledger.sql', '005_reconciliation.sql', '006_payment_refunds.sql', '007_merchant_delivery.sql', '008_refund_authorizations.sql', '009_refund_requests.sql', '010_finance_refund_jobs.sql', '011_gateway_demo_purchases.sql', '012_gateway_demo_deliveries.sql', '013_gateway_payment_observations.sql', '014_gateway_task_accounting.sql', '015_gateway_background_reconciliation.sql', '016_gateway_operations_observations.sql', '017_wallet_funding.sql', '018_audit_history.sql', '019_gateway_refunds.sql', '020_gateway_purchase_network.sql', '021_gateway_merchants.sql', '022_gateway_delivery_disputes.sql', '023_audit_hash_chain.sql', '024_delivery_commitment.sql', '025_merchant_recipient_change.sql', '026_refund_submission_intent.sql', '027_refund_journal_account.sql', '028_balance_scan.sql', '029_dispute_refund_states.sql'];

async function runFiles(pool: Pool, files: string[]) {
  for (const file of files) {
    const sql = await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8');
    await pool.query(sql);
  }
}

test('legacy data is upgraded correctly when the new migrations run', { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agup-'));
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
  await runFiles(pool, legacyFiles);

  const address = () => `0x${randomBytes(20).toString('hex')}`;

  // --- Seed pre-fix legacy data ------------------------------------------------

  const agentId = randomUUID();
  await pool.query(
    'INSERT INTO agents (id, token_digest, enabled) VALUES ($1, $2, true)',
    [agentId, Buffer.from(randomUUID().replace(/-/g, ''), 'hex')]);
  await pool.query(`
    INSERT INTO research_tasks (id, agent_id, active_until, enabled, budget, daily_limit, reserved, spent)
    VALUES ($1, $2, now() + interval '1 day', true, 100000, 10000, 0, 0)
  `, [randomUUID(), agentId]);

  const payer = address();
  const recipient = address();

  // Dispute #1: approved under the old code (status REFUNDED) but never actually
  // refunded — no gateway_payment_refunds row.
  const requestA = randomUUID();
  await pool.query(`
    INSERT INTO gateway_demo_purchases (request_id, endpoint, nonce, payer, recipient, amount_units)
    VALUES ($1, $2, $3, $4, $5, 1000)
  `, [requestA, 'https://api.example/a', `0x${'a'.repeat(64)}`, payer, recipient]);
  await pool.query(`
    INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
    VALUES ($1, $2, $3, 1000)
  `, [requestA, 'transfer-a', `0x${'1'.repeat(64)}`]);
  await pool.query(`
    INSERT INTO gateway_delivery_disputes (request_id, reason, evidence, status, raised_by, decided_by, decided_at)
    VALUES ($1, 'wrong result', '{"expected":1,"received":2}', 'REFUNDED', $2, 'finance', now())
  `, [requestA, agentId]);

  // Dispute #2: approved AND actually refunded — a gateway_payment_refunds row
  // exists, so it must stay REFUNDED.
  const requestB = randomUUID();
  await pool.query(`
    INSERT INTO gateway_demo_purchases (request_id, endpoint, nonce, payer, recipient, amount_units)
    VALUES ($1, $2, $3, $4, $5, 1000)
  `, [requestB, 'https://api.example/b', `0x${'b'.repeat(64)}`, payer, recipient]);
  await pool.query(`
    INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
    VALUES ($1, $2, $3, 1000)
  `, [requestB, 'transfer-b', `0x${'2'.repeat(64)}`]);
  await pool.query(`
    INSERT INTO gateway_delivery_disputes (request_id, reason, evidence, status, raised_by, decided_by, decided_at)
    VALUES ($1, 'wrong result', '{"expected":1,"received":2}', 'REFUNDED', $2, 'finance', now())
  `, [requestB, agentId]);
  await pool.query(`
    INSERT INTO gateway_payment_refunds (request_id, network, transaction_hash, log_index, block_number, block_hash, reason)
    VALUES ($1, 'arcTestnet', $2, 0, 1, $3, 'wrong result')
  `, [requestB, `0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`]);

  // Merchant with a pending recipient staged before version columns existed.
  const merchantId = randomUUID();
  await pool.query(`
    INSERT INTO gateway_merchants (id, recipient, endpoint_origin, network)
    VALUES ($1, $2, 'https://api.example/m', 'arcTestnet')
  `, [merchantId, address()]);
  await pool.query(`
    UPDATE gateway_merchants
    SET pending_recipient = $2, pending_recipient_requested_by = 'ops',
        pending_recipient_requested_at = now()
    WHERE id = $1
  `, [merchantId, address()]);

  // --- Apply the new migrations on top of the legacy data ----------------------

  await runFiles(pool, ['030_merchant_recipient_version.sql', '031_legacy_dispute_upgrade.sql']);

  // The un-refunded approval becomes REFUND_APPROVED.
  const { rows: [disputeA] } = await pool.query(
    "SELECT status FROM gateway_delivery_disputes WHERE request_id = $1", [requestA]);
  assert.equal(disputeA.status, 'REFUND_APPROVED');

  // The actually-refunded dispute stays REFUNDED.
  const { rows: [disputeB] } = await pool.query(
    "SELECT status FROM gateway_delivery_disputes WHERE request_id = $1", [requestB]);
  assert.equal(disputeB.status, 'REFUNDED');

  // The pending recipient gained a version, so the new CHECK constraint holds.
  const { rows: [merchant] } = await pool.query(
    'SELECT pending_recipient_version FROM gateway_merchants WHERE id = $1', [merchantId]);
  assert.ok(merchant.pending_recipient_version >= 1);
});
