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
import { checkGatewayPayment } from '../src/gateway-payment-evidence.js';

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

test('a failed Gateway lookup keeps its free-text failure reason', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agcpe-'));
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
  const requestId = randomUUID();
  const nonce = `0x${randomBytes(32).toString('hex')}`;
  await pool.query(`
    INSERT INTO gateway_demo_purchases (request_id, endpoint, nonce, payer, recipient, amount_units, network)
    VALUES ($1, $2, $3, $4, $5, 1000, 'arcTestnet')
  `, [requestId, 'https://merchant.example/trace', nonce, payer, recipient]);

  const evidence = await checkGatewayPayment(pool, requestId, {
    nonce, payer, recipient, amountUnits: '1000', network: 'arcTestnet',
  }, 'finance', async () => new Response(null, { status: 503 }));

  assert.equal(evidence.status, 'unavailable');
  assert.equal(evidence.reason, 'Gateway transfer lookup returned HTTP 503');

  const { rows: [observation] } = await pool.query(
    "SELECT evidence->>'status' AS status, evidence->>'reason' AS reason FROM gateway_payment_observations WHERE request_id = $1",
    [requestId]);
  assert.equal(observation.status, 'unavailable');
  assert.equal(observation.reason, 'Gateway transfer lookup returned HTTP 503');
});
