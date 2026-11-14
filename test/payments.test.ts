import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { baseSepoliaUsdc, createBaseSettlement } from '../src/base-settlement.js';
import type { Authorization, SettlementRail } from '../src/base-settlement.js';
import { processSettlement } from '../src/settlement-worker.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { processQuote } from '../src/quote-worker.js';
import { seed } from '../src/seed.js';

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

test('payment API against PostgreSQL', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenttreasury-db-'));
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
  const app = buildApp(pool);
  const replica = buildApp(pool);
  t.after(async () => {
    try {
      await Promise.all([app.close(), replica.close()]);
      await pool.end();
      if (started) await postgres.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await postgres.initialise();
  await postgres.start();
  started = true;
  assert.equal((await app.inject({ url: '/health/ready' })).statusCode, 503);
  await Promise.all([migrate(pool), migrate(pool)]);
  assert.equal((await app.inject({ url: '/health/ready' })).statusCode, 200);

  const buyer = await seed(pool);
  const stranger = await seed(pool);
  const headers = { authorization: `Bearer ${buyer.token}` };
  const purchase = { taskId: buyer.taskId, serviceId: buyer.serviceId };
  const post = (key: string, requestId: string, server = app) => server.inject({
    method: 'POST', url: '/payment-intents',
    headers: { ...headers, 'idempotency-key': key }, payload: { ...purchase, requestId },
  });

  await t.test('rejects cross-task access, unlisted service and caller-supplied payout details', async () => {
    const send = (payload: object, auth = headers) => app.inject({
      method: 'POST', url: '/payment-intents', headers: { ...auth, 'idempotency-key': 'invalid' }, payload,
    });
    const request = { ...purchase, requestId: randomUUID() };
    assert.equal((await send(request, { authorization: 'Bearer invalid' })).statusCode, 401);
    assert.equal((await send({ ...request, taskId: stranger.taskId })).statusCode, 404);
    assert.equal((await send({ ...request, serviceId: stranger.serviceId })).statusCode, 403);
    assert.equal((await send({ ...request, payee: '0xBAD' })).statusCode, 400);
  });

  await t.test('two API instances cannot concurrently overspend the same task', async () => {
    const inputs = [{ key: 'a', id: randomUUID() }, { key: 'b', id: randomUUID() }];
    const results = await Promise.all(inputs.map(({ key, id }, i) => post(key, id, i ? replica : app)));
    assert.deepEqual(results.map((result) => result.statusCode), [201, 201]);
    assert.deepEqual(results.map((result) => result.json().status).sort(), ['REJECTED', 'RESERVED']);

    const winner = results.findIndex((result) => result.json().status === 'RESERVED');
    const request = inputs[winner]!;
    const response = results[winner]!;
    const replay = await post(request.key, request.id, replica);
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), response.json());
    assert.equal((await post(request.key, randomUUID())).statusCode, 409);
    assert.equal((await post('new-key', request.id)).statusCode, 409);

    assert.equal((await app.inject({ url: response.headers.location!, headers })).statusCode, 200);
    assert.equal((await app.inject({
      url: response.headers.location!, headers: { authorization: `Bearer ${stranger.token}` },
    })).statusCode, 404);

    const { rows: [totals] } = await pool.query(`
      SELECT t.reserved AS task_reserved, d.reserved AS daily_reserved,
        (SELECT count(*) FROM outbox) AS outbox_count
      FROM research_tasks t JOIN daily_spend d ON d.task_id = t.id WHERE t.id = $1
    `, [buyer.taskId]);
    assert.deepEqual(totals, { task_reserved: '2000', daily_reserved: '2000', outbox_count: '1' });
  });

  await t.test('daily cap still applies when total task budget remains', async () => {
    const fixture = await seed(pool, 10_000, 2000);
    async function buy() {
      return app.inject({
        method: 'POST', url: '/payment-intents',
        headers: { authorization: `Bearer ${fixture.token}`, 'idempotency-key': randomUUID() },
        payload: { taskId: fixture.taskId, serviceId: fixture.serviceId, requestId: randomUUID() },
      });
    }
    assert.equal((await buy()).json().status, 'RESERVED');
    assert.equal((await buy()).json().reason, 'DAILY_LIMIT_EXCEEDED');
  });

  await t.test('quote workers claim once and release rejected quotes atomically', async () => {
    const calls: string[] = [];
    const approved = '0x0000000000000000000000000000000000000001';
    const fetchQuote = async (url: string | URL | Request) => {
      calls.push(String(url));
      const recipient = calls.length === 1 ? approved : '0x0000000000000000000000000000000000000002';
      return new Response(null, { status: 402, headers: {
        'payment-required': Buffer.from(JSON.stringify({
          x402Version: 2,
          resource: { url },
          accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: '2000',
            asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', payTo: recipient, maxTimeoutSeconds: 60 }],
        })).toString('base64'),
      } });
    };
    await Promise.all([processQuote(pool, fetchQuote), processQuote(pool, fetchQuote)]);
    assert.equal(calls.length, 2);
    assert.equal(await processQuote(pool, fetchQuote), false);
    const { rows } = await pool.query(`
      SELECT i.status, i.reason, t.reserved
      FROM payment_intents i JOIN research_tasks t ON t.id = i.task_id
      WHERE i.status IN ('QUOTED', 'FAILED') ORDER BY i.status
    `);
    assert.deepEqual(rows, [
      { status: 'FAILED', reason: 'QUOTE_MISMATCH', reserved: '0' },
      { status: 'QUOTED', reason: null, reserved: '2000' },
    ]);
    const { rows: [events] } = await pool.query(
      "SELECT count(*) FROM outbox WHERE event_type = 'payment.quoted'",
    );
    assert.equal(events?.count, '1');
  });

  await t.test('uncertain submission keeps its reservation and reuses the signed authorization', async () => {
    const { rail: signer } = createBaseSettlement('http://127.0.0.1:1', generatePrivateKey(), generatePrivateKey());
    const hash = `0x${'ab'.repeat(32)}` as const;
    const submitted: Authorization[] = [];
    let signs = 0;
    let finalized = false;
    const rail: SettlementRail = {
      head: async () => ({ block: 123n, timestamp: 1000n }),
      async sign(...args) {
        signs++;
        return signer.sign(...args);
      },
      async observe() {
        if (finalized) return { status: 'settled', hash };
        return { status: 'ready' };
      },
      async submit(authorization) {
        submitted.push(authorization);
        if (submitted.length === 1) throw new Error('Simulated lost RPC response');
        return hash;
      },
    };
    const state = async () => (await pool.query(`
      SELECT i.status, i.transaction_hash, t.reserved, t.spent
      FROM outbox o JOIN payment_intents i ON i.id = o.intent_id
      JOIN research_tasks t ON t.id = i.task_id WHERE o.event_type = 'payment.quoted'
    `)).rows[0];
    const due = () => pool.query("UPDATE outbox SET available_at = now() WHERE event_type = 'payment.quoted'");

    await Promise.all([processSettlement(pool, rail), processSettlement(pool, rail)]);
    assert.equal(signs, 1);
    assert.equal(submitted.length, 1);
    assert.deepEqual(await state(), { status: 'UNKNOWN', transaction_hash: null, reserved: '2000', spent: '0' });
    await due();
    await processSettlement(pool, rail);
    assert.equal(signs, 1);
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[0], submitted[1]);
    const { from, to, value, validAfter, validBefore, nonce, signature } = submitted[0]!;
    assert.equal(await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: baseSepoliaUsdc },
      types: { TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ] },
      primaryType: 'TransferWithAuthorization',
      message: { from, to, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce },
      signature,
    }), from);
    assert.deepEqual(await state(), { status: 'SUBMITTED', transaction_hash: hash, reserved: '2000', spent: '0' });
    finalized = true;
    await due();
    await processSettlement(pool, rail);
    assert.deepEqual(await state(), { status: 'SETTLED', transaction_hash: hash, reserved: '0', spent: '2000' });
    assert.equal(await processSettlement(pool, rail), false);
  });
});
