import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { lockGatewayGrant } from '../src/gateway-budget.js';
import { transaction } from '../src/db.js';
import {
  confirmGatewayMerchantRecipientChange, requestGatewayMerchantRecipientChange,
} from '../src/gateway-merchant-recipient.js';

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

test('gateway grant authorization requires the matching network', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenttreasury-gateway-budget-'));
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
  const origin = 'http://127.0.0.1:3002';
  const seeded = await seedGateway(pool, { origin, payer, recipient, network: 'arcTestnet' });

  const termsFor = (network: 'arc' | 'arcTestnet') => {
    const requestId = randomUUID();
    return {
      requestId,
      endpoint: `${origin}/trace/${requestId}`,
      payer,
      recipient,
      network,
    };
  };

  await t.test('accepts the granted network', async () => {
    const grant = await transaction(pool, (client) => lockGatewayGrant(
      client, { taskId: seeded.taskId, agentToken: seeded.token }, termsFor('arcTestnet'),
    ));
    assert.ok(grant.day);
  });

  await t.test('rejects a different network under the same address and service', async () => {
    await assert.rejects(
      transaction(pool, (client) => lockGatewayGrant(
        client, { taskId: seeded.taskId, agentToken: seeded.token }, termsFor('arc'),
      )),
      (error: Error & { code?: string }) => error.code === 'GATEWAY_PAYMENT_TERMS_NOT_ALLOWED',
    );
  });

  await t.test('rejects a grant after the merchant payout address changed', async () => {
    const next = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const staged = await requestGatewayMerchantRecipientChange(pool, seeded.merchantId, next, 'ops');
    await confirmGatewayMerchantRecipientChange(pool, seeded.merchantId, staged.pendingRecipientVersion!, next);
    await assert.rejects(
      transaction(pool, (client) => lockGatewayGrant(
        client, { taskId: seeded.taskId, agentToken: seeded.token }, termsFor('arcTestnet'),
      )),
      (error: Error & { code?: string }) => error.code === 'GATEWAY_RECIPIENT_SUPERSEDED',
    );
  });
});
