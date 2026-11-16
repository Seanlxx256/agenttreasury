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

test('gateway refund journal debits the normal wallet, not the gateway deposit', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenttreasury-refund-accounting-'));
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
  await pool.query(`
    INSERT INTO gateway_payment_refunds (request_id, network, transaction_hash, log_index, block_number, block_hash, reason)
    VALUES ($1, 'eip155:5042', $2, 5, 200, $3, 'dispute upheld')
  `, [requestId, `0x${randomBytes(32).toString('hex')}`, `0x${randomBytes(32).toString('hex')}`]);

  const { rows } = await pool.query(
    'SELECT account, side FROM gateway_refund_journal_lines WHERE request_id = $1 ORDER BY number', [requestId]);
  assert.deepEqual(rows.map((row) => [row.account, row.side]), [
    ['USDC_WALLET_ASSET', 'DEBIT'],
    ['DATA_PROCUREMENT_EXPENSE', 'CREDIT'],
  ]);
});
