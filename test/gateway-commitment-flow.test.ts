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
import { buildGatewayMerchant } from '../src/gateway-merchant.js';
import { purchaseGatewayTrace } from '../src/gateway-purchase.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { seedGateway } from '../src/seed.js';
import { arcGatewayNetwork, decodePaymentHeader, encodePaymentHeader, gatewayDomain, gatewayValidity } from '../src/gateway-x402.js';
import { traceDeliveryCommitment } from '../src/delivery-commitment.js';

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

test('finance console exposes the commitment assessment', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agcc-'));
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
  const financeToken = randomUUID();
  const operationsToken = randomUUID();
  const app = buildApp(pool, false, undefined, financeToken, false, operationsToken);
  t.after(async () => {
    try {
      await app.close();
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
  const seeded = await seedGateway(pool, { origin, payer, recipient });

  const requestId = randomUUID();
  const nonce = `0x${randomBytes(32).toString('hex')}`;
  await pool.query(`
    INSERT INTO gateway_demo_purchases
      (request_id, endpoint, nonce, payer, recipient, amount_units, task_id, budget_day,
       budget_status, submitted_at, delivery, delivery_commitment, commitment_satisfied, commitment_violations)
    VALUES ($1, $2, $3, $4, $5, 1000, $6, '2026-01-01', 'spent', now(), $7, $8, false, $9)
  `, [requestId, `${origin}/trace/${requestId}`, nonce, payer, recipient, seeded.taskId,
      JSON.stringify({ requestId, nonce, gatewayReference: 'ref-1', trace: { source: 'fixture', calls: [{ type: 'CALL', error: 'execution reverted' }] } }),
      JSON.stringify(traceDeliveryCommitment),
      JSON.stringify(['trace.calls[0] errored: execution reverted'])]);
  await pool.query(`
    INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
    VALUES ($1, $2, $3, 1000)
  `, [requestId, randomUUID(), `0x${randomBytes(32).toString('hex')}`]);

  const response = await app.inject({
    url: `/finance/gateway-purchases/${requestId}`,
    headers: { authorization: `Bearer ${operationsToken}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.commitmentSatisfied, false);
  assert.deepEqual(body.commitmentViolations, ['trace.calls[0] errored: execution reverted']);
});

test('delivery recovery verifies against the stored commitment, not a locally regenerated one', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agrc-'));
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

  const payer = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const origin = 'http://127.0.0.1:3002';
  const seeded = await seedGateway(pool, { origin, payer: payer.address, recipient });
  const task = { taskId: seeded.taskId, agentToken: seeded.token };

  const merchant = buildGatewayMerchant(pool, origin, recipient, async (url, init) => {
    const { paymentPayload, paymentRequirements } = JSON.parse(String(init?.body));
    const nonce = paymentPayload.payload.authorization.nonce;
    const saved = await pool.query('SELECT nonce FROM gateway_demo_purchases WHERE nonce = $1', [nonce]);
    assert.equal(saved.rowCount, 1);
    assert.equal(paymentRequirements.network, arcGatewayNetwork);
    return Response.json({ success: true, transaction: randomUUID(), network: arcGatewayNetwork, payer: payer.address });
  });
  const sign: Parameters<typeof purchaseGatewayTrace>[2] = (data) => {
    assert.deepEqual(data.domain, gatewayDomain);
    assert.ok(BigInt(data.message.validBefore) >= BigInt(Math.floor(Date.now() / 1000) + gatewayValidity - 1));
    return payer.signTypedData({
      ...data,
      message: {
        ...data.message, value: BigInt(data.message.value),
        validAfter: BigInt(data.message.validAfter), validBefore: BigInt(data.message.validBefore),
      },
    });
  };
  const send: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    const response = await merchant.inject({
      method: init?.method === 'GET' ? 'GET' : 'POST',
      url: String(url), headers: Object.fromEntries(headers),
    });
    return new Response(response.body, { status: response.statusCode, headers: response.headers as Record<string, string> });
  };
  const makePurchase = (requestId = randomUUID()) => ({
    requestId, payer: payer.address, recipient, endpoint: `${origin}/trace/${requestId}`, task,
  });

  const purchase = makePurchase();

  // A quote whose delivery commitment diverges from the locally declared one is
  // rejected before any budget is reserved or any row is inserted.
  const divergentQuote: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('payment-signature')) {
      const base = await send(url, init);
      const required = decodePaymentHeader(base.headers.get('payment-required'));
      required.resource.deliveryCommitment = { trace: { calls: [{ type: 'CALL', status: 'reverted' }] } };
      const altered = new Headers(base.headers);
      altered.set('payment-required', encodePaymentHeader(required));
      return new Response(base.body, { status: 402, headers: altered });
    }
    return send(url, init);
  };
  await assert.rejects(
    purchaseGatewayTrace(pool, makePurchase(), sign, divergentQuote),
    /Gateway quote differs from the approved terms/,
  );

  // Submit, then lose the paid response so delivery is never saved on the buyer side.
  const lost = await purchaseGatewayTrace(pool, purchase, sign, async (url, init) => {
    const response = await send(url, init);
    if (new Headers(init?.headers).has('payment-signature')) throw new Error('Lost paid response');
    return response;
  });
  assert.equal(lost.status, 'submission-unknown');

  // Rewrite the stored commitment to expect a reverted call, and make the merchant
  // hold a clean successful delivery. Recovery must judge against the stored
  // commitment, not the locally regenerated success commitment.
  await pool.query(
    `UPDATE gateway_demo_purchases SET delivery_commitment = $2 WHERE request_id = $1`,
    [purchase.requestId, JSON.stringify({ trace: { calls: [{ type: 'CALL', status: 'reverted' }] } })],
  );
  await pool.query(
    `UPDATE gateway_demo_deliveries SET delivery = $2 WHERE request_id = $1`,
    [purchase.requestId, JSON.stringify({ requestId: purchase.requestId, nonce: lost.nonce,
      gatewayReference: 'ref-1', trace: { source: 'fixture', calls: [{ type: 'CALL', status: 'success' }] } })],
  );

  const gateway: typeof fetch = async (url) => {
    assert.equal(new URL(String(url)).searchParams.get('nonce'), lost.nonce);
    return Response.json({ transfers: [{
      id: randomUUID(), txHash: `0x${'b'.repeat(64)}`, status: 'confirmed',
      nonce: lost.nonce, fromAddress: payer.address, toAddress: recipient,
      token: 'USDC', sendingNetwork: arcGatewayNetwork, recipientNetwork: arcGatewayNetwork, amount: '1000',
    }] });
  };
  const recovered = await purchaseGatewayTrace(pool, purchase, sign, send, gateway);
  assert.equal(recovered.status, 'delivered');

  const { rows: [row] } = await pool.query(
    'SELECT commitment_satisfied AS "satisfied", commitment_violations AS "violations" FROM gateway_demo_purchases WHERE request_id = $1',
    [purchase.requestId]);
  assert.equal(row.satisfied, false);
  assert.deepEqual(row.violations, ['trace.calls[0] status success != reverted']);
});
