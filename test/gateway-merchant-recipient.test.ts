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
import {
  confirmGatewayMerchantRecipientChange, requestGatewayMerchantRecipientChange,
  reauthorizeGatewayGrantRecipient,
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

test('merchant payout address changes require a human review', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenttreasury-merchant-recipient-'));
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

  const newMerchant = async () => {
    const payer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const recipient = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const seeded = await seedGateway(pool, { origin: 'http://127.0.0.1:3002', payer, recipient });
    return { merchantId: seeded.merchantId, recipient, taskId: seeded.taskId };
  };

  await t.test('requesting a change stages the address without moving the live recipient', async () => {
    const { merchantId, recipient } = await newMerchant();
    const next = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const updated = await requestGatewayMerchantRecipientChange(pool, merchantId, next, 'ops');
    assert.equal(updated.recipient, recipient);
    assert.equal(updated.pendingRecipient, next);
    assert.equal(updated.pendingRecipientRequestedBy, 'ops');
    assert.ok(updated.pendingRecipientRequestedAt);
  });

  await t.test('confirming applies the staged address and clears the pending state', async () => {
    const { merchantId, recipient } = await newMerchant();
    const next = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const staged = await requestGatewayMerchantRecipientChange(pool, merchantId, next, 'ops');
    const confirmed = await confirmGatewayMerchantRecipientChange(
      pool, merchantId, staged.pendingRecipientVersion!, next);
    assert.equal(confirmed.recipient, next);
    assert.notEqual(confirmed.recipient, recipient);
    assert.equal(confirmed.pendingRecipient, null);
    assert.equal(confirmed.pendingRecipientRequestedBy, null);
    assert.equal(confirmed.recipientChangeVersion, staged.pendingRecipientVersion);
  });

  await t.test('stale confirmation is rejected when a newer request overwrote the pending address', async () => {
    const { merchantId } = await newMerchant();
    const first = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const second = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const stagedFirst = await requestGatewayMerchantRecipientChange(pool, merchantId, first, 'ops');
    await requestGatewayMerchantRecipientChange(pool, merchantId, second, 'ops');
    await assert.rejects(
      confirmGatewayMerchantRecipientChange(pool, merchantId, stagedFirst.pendingRecipientVersion!, first),
      (error: Error & { code?: string }) => error.code === 'RECIPIENT_CHANGE_STALE',
    );
  });

  await t.test('reauthorizing a grant moves it to the reviewed recipient', async () => {
    const { merchantId, recipient, taskId } = await newMerchant();
    const next = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const staged = await requestGatewayMerchantRecipientChange(pool, merchantId, next, 'ops');
    await confirmGatewayMerchantRecipientChange(pool, merchantId, staged.pendingRecipientVersion!, next);
    const updated = await reauthorizeGatewayGrantRecipient(pool, taskId, next, staged.pendingRecipientVersion!, 'finance-operator');
    assert.equal(updated.recipient, next);
    assert.notEqual(updated.recipient, recipient);
  });

  await t.test('reauthorization is rejected when the reviewed recipient is stale', async () => {
    const { merchantId, taskId } = await newMerchant();
    const next = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const staged = await requestGatewayMerchantRecipientChange(pool, merchantId, next, 'ops');
    await confirmGatewayMerchantRecipientChange(pool, merchantId, staged.pendingRecipientVersion!, next);
    const stale = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    await assert.rejects(
      reauthorizeGatewayGrantRecipient(pool, taskId, stale, staged.pendingRecipientVersion!, 'finance-operator'),
      (error: Error & { code?: string }) => error.code === 'RECIPIENT_CHANGE_STALE',
    );
  });

  await t.test('rejects a change to the current address', async () => {
    const { merchantId, recipient } = await newMerchant();
    await assert.rejects(requestGatewayMerchantRecipientChange(pool, merchantId, recipient, 'ops'),
      (error: Error & { code?: string }) => error.code === 'RECIPIENT_UNCHANGED');
  });

  await t.test('rejects an invalid address', async () => {
    const { merchantId } = await newMerchant();
    await assert.rejects(requestGatewayMerchantRecipientChange(pool, merchantId, '0xnot-an-address', 'ops'),
      (error: Error & { code?: string }) => error.code === 'INVALID_RECIPIENT');
  });

  await t.test('confirmation without a pending change is rejected', async () => {
    const { merchantId, recipient } = await newMerchant();
    await assert.rejects(confirmGatewayMerchantRecipientChange(pool, merchantId, 1, recipient),
      (error: Error & { code?: string }) => error.code === 'NO_PENDING_RECIPIENT');
  });

  await t.test('replacing a pending proposal twice invalidates its original version even at the same address', async () => {
    const { merchantId } = await newMerchant();
    const first = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const second = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const reviewed = await requestGatewayMerchantRecipientChange(pool, merchantId, first, 'ops');
    await requestGatewayMerchantRecipientChange(pool, merchantId, second, 'ops');
    const latest = await requestGatewayMerchantRecipientChange(pool, merchantId, first, 'ops');
    assert.ok(latest.pendingRecipientVersion > reviewed.pendingRecipientVersion);
    await assert.rejects(confirmGatewayMerchantRecipientChange(pool, merchantId, reviewed.pendingRecipientVersion, first),
      (error: Error & { code?: string }) => error.code === 'RECIPIENT_CHANGE_STALE');
    await confirmGatewayMerchantRecipientChange(pool, merchantId, latest.pendingRecipientVersion, first);
  });

});
