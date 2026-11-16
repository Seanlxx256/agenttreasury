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
import { collectGatewayPatterns } from '../src/gateway-patterns.js';

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

test('cross-case patterns surface from the observation log', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agpat-'));
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

  const recordFailed = async (reason: string) => {
    const requestId = randomUUID();
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    await pool.query(`
      INSERT INTO gateway_demo_purchases
        (request_id, endpoint, nonce, payer, recipient, amount_units, task_id, budget_day, budget_status, submitted_at)
      VALUES ($1, $2, $3, $4, $5, 1000, $6, '2026-01-01', 'spent', now())
    `, [requestId, `http://127.0.0.1:3002/trace/${requestId}`, nonce, payer, recipient, seeded.taskId]);
    await pool.query(`
      INSERT INTO gateway_payment_observations (request_id, source, evidence)
      VALUES ($1, 'finance', $2)
    `, [requestId, JSON.stringify({ status: 'failed', reason })]);
  };

  // Two nonce-related failures plus an unrelated funding gap on the same merchant.
  await recordFailed('nonce already used for this wallet');
  await recordFailed('nonce already consumed by a prior transfer');
  await recordFailed('the wallet ran dry');

  const patterns = await collectGatewayPatterns(pool);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0]?.merchantId, seeded.merchantId);
  // Two shared nonce signals outweigh the single funding signal.
  assert.equal(patterns[0]?.pattern, 'supplier-nonce-bug');
  assert.equal(patterns[0]?.cases.length, 3);

  // A lone failure from another merchant must not be attributed to the first.
  const otherPayer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const otherRecipient = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const other = await seedGateway(pool, { origin: 'http://127.0.0.1:3003', payer: otherPayer, recipient: otherRecipient });
  const requestId = randomUUID();
  const nonce = `0x${randomBytes(32).toString('hex')}`;
  await pool.query(`
    INSERT INTO gateway_demo_purchases
      (request_id, endpoint, nonce, payer, recipient, amount_units, task_id, budget_day, budget_status, submitted_at)
    VALUES ($1, $2, $3, $4, $5, 1000, $6, '2026-01-01', 'spent', now())
  `, [requestId, `http://127.0.0.1:3003/trace/${requestId}`, nonce, otherPayer, otherRecipient, other.taskId]);
  await pool.query(`
    INSERT INTO gateway_payment_observations (request_id, source, evidence)
    VALUES ($1, 'finance', $2)
  `, [requestId, JSON.stringify({ status: 'failed', reason: 'signature verification failed' })]);

  const grouped = await collectGatewayPatterns(pool);
  assert.equal(grouped.length, 2);
  const byMerchant = new Map(grouped.map((entry) => [entry.merchantId, entry]));
  assert.equal(byMerchant.get(other.merchantId)?.pattern, 'no-systemic-pattern');
  assert.equal(byMerchant.get(other.merchantId)?.cases.length, 1);
});
