import { processFinanceRefund } from '../src/finance-refunds.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildGatewayMerchant } from '../src/gateway-merchant.js';
import { purchaseGatewayTrace } from '../src/gateway-purchase.js';
import { collectGatewayPurchaseEvidence } from '../src/gateway-purchase-evidence.js';
import { processGatewayReconciliation } from '../src/gateway-reconciliation-worker.js';
import type { GatewayBalanceChain } from '../src/gateway-balance-chain.js';
import { reconcileGatewayBalances } from '../src/reconcile-gateway-balances.js';
import { reserveAmount } from '../src/budget.js';
import { transaction } from '../src/db.js';
import { arcGatewayNetwork, gatewayDomain, gatewayValidity } from '../src/gateway-x402.js';
import { baseSepoliaUsdc, createBaseSettlement } from '../src/base-settlement.js';
import type { Authorization, SettlementRail } from '../src/base-settlement.js';
import { reconcilePayments } from '../src/reconciliation.js';
import type { ReconciliationChain } from '../src/reconciliation.js';
import { buildMerchant, deliverySignature } from '../src/merchant.js';
import { recordRefund } from '../src/refunds.js';
import { recordFunding } from '../src/record-funding.js';
import type { RefundChain } from '../src/refunds.js';
import { collectPurchaseEvidence } from '../src/purchase-evidence.js';
import { processSettlement } from '../src/settlement-worker.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { processQuote } from '../src/quote-worker.js';
import { seed, seedGateway } from '../src/seed.js';

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

  await t.test('Gateway worker reconciles after lease expiry and preserves uncertain budgets for review', async () => {
    const payer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const recipient = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const origin = 'http://127.0.0.1:3002';
    const seeded = await seedGateway(pool, { origin, payer, recipient }, 3000, 3000);
    const taskId = seeded.taskId;
    const makeReserved = async (submitted: boolean) => {
      const id = randomUUID();
      const nonce = `0x${randomBytes(32).toString('hex')}`;
      await transaction(pool, async (client) => {
        await reserveAmount(client, taskId, '2026-01-01', '1000');
        await client.query(`
          INSERT INTO gateway_demo_purchases
            (request_id, endpoint, nonce, payer, recipient, amount_units, task_id, budget_day,
             budget_status, authorized_at, submitted_at)
          VALUES ($1, $2, $3, $4, $5, 1000, $6, '2026-01-01',
            'reserved', now() - interval '3 minutes', CASE WHEN $7 THEN now() END)
        `, [id, `${origin}/trace/${id}`, nonce, payer, recipient, taskId, submitted]);
      });
      return { id, nonce };
    };
    const counters = async () =>
      (await pool.query('SELECT reserved, spent FROM research_tasks WHERE id = $1', [taskId])).rows[0];
    const abandoned = await makeReserved(false);
    const noNetwork: typeof fetch = () => {
      assert.fail('An unsubmitted purchase does not need a Gateway lookup');
    };
    assert.equal(await processGatewayReconciliation(pool, noNetwork), true);
    assert.deepEqual(await counters(), { reserved: '0', spent: '0' });
    const expiry = await pool.query(
      'SELECT evidence FROM gateway_payment_observations WHERE request_id = $1 AND source = $2',
      [abandoned.id, 'worker'],
    );
    assert.deepEqual(expiry.rows[0]?.evidence, { status: 'submission-expired' });

    const submitted = await makeReserved(true);
    await pool.query("UPDATE gateway_demo_purchases SET reconcile_after = now() + interval '30 seconds' WHERE request_id = $1",
      [submitted.id]);
    assert.equal(await processGatewayReconciliation(pool, noNetwork), false);
    await pool.query("UPDATE gateway_demo_purchases SET reconcile_after = now() - interval '1 second' WHERE request_id = $1",
      [submitted.id]);
    let lookups = 0;
    const gateway: typeof fetch = async (url) => {
      ++lookups;
      assert.equal(new URL(String(url)).searchParams.get('nonce'), submitted.nonce);
      return Response.json({ transfers: [{
        id: randomUUID(), status: 'confirmed', nonce: submitted.nonce, fromAddress: payer, toAddress: recipient,
        token: 'USDC', sendingNetwork: arcGatewayNetwork, recipientNetwork: arcGatewayNetwork, amount: '1000',
        txHash: `0x${'b'.repeat(64)}`,
      }] });
    };
    const work = await Promise.all([processGatewayReconciliation(pool, gateway), processGatewayReconciliation(pool, gateway)]);
    assert.equal(work.filter(Boolean).length, 1);
    assert.equal(lookups, 1);
    assert.deepEqual(await counters(), { reserved: '0', spent: '1000' });
    const journal = await pool.query('SELECT 1 FROM gateway_payment_journal WHERE request_id = $1', [submitted.id]);
    assert.equal(journal.rowCount, 1);

    const uncertain = await makeReserved(true);
    const noTransfer: typeof fetch = async () => Response.json({ transfers: [] });
    assert.equal(await processGatewayReconciliation(pool, noTransfer), true);
    assert.equal(await processGatewayReconciliation(pool, noNetwork), false);
    await pool.query('UPDATE gateway_demo_purchases SET reconcile_attempts = 11, reconcile_after = now() WHERE request_id = $1',
      [uncertain.id]);
    assert.equal(await processGatewayReconciliation(pool, noTransfer), true);
    assert.equal(await processGatewayReconciliation(pool, noNetwork), false);
    const review = await pool.query(
      'SELECT reconcile_attempts, reconcile_review_at IS NOT NULL AS review FROM gateway_demo_purchases WHERE request_id = $1',
      [uncertain.id],
    );
    assert.deepEqual(review.rows[0], { reconcile_attempts: 12, review: true });
    assert.deepEqual(await counters(), { reserved: '1000', spent: '1000' });

    // Concurrent workers must claim distinct purchases without double handling.
    {
      const payer2 = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      const recipient2 = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      const seeded2 = await seedGateway(pool, { origin, payer: payer2, recipient: recipient2 }, 10000, 10000);
      const taskId2 = seeded2.taskId;
      const makeSubmitted = async () => {
        const id = randomUUID();
        const nonce = `0x${randomBytes(32).toString('hex')}`;
        await transaction(pool, async (client) => {
          await reserveAmount(client, taskId2, '2026-01-01', '1000');
          await client.query(`
            INSERT INTO gateway_demo_purchases
              (request_id, endpoint, nonce, payer, recipient, amount_units, task_id, budget_day,
               budget_status, authorized_at, submitted_at, reconcile_after)
            VALUES ($1, $2, $3, $4, $5, 1000, $6, '2026-01-01',
              'reserved', now() - interval '3 minutes', now(), now() - interval '1 second')
          `, [id, `${origin}/trace/${id}`, nonce, payer2, recipient2, taskId2]);
        });
        return { id, nonce };
      };
      const p1 = await makeSubmitted();
      const p2 = await makeSubmitted();
      const purchases = [p1, p2];
      let lookups = 0;
      const seen = new Set<string>();
      const gateway: typeof fetch = async (url) => {
        const nonce = new URL(String(url)).searchParams.get('nonce');
        if (nonce) seen.add(nonce);
        ++lookups;
        return Response.json({ transfers: [{
          id: randomUUID(), status: 'confirmed', nonce, fromAddress: payer2, toAddress: recipient2,
          token: 'USDC', sendingNetwork: arcGatewayNetwork, recipientNetwork: arcGatewayNetwork,
          amount: '1000', txHash: `0x${'c'.repeat(64)}`,
        }] });
      };
      // Two worker invocations race for two due purchases: SKIP LOCKED plus the
      // reconcile_after lease must ensure each purchase is claimed exactly once.
      const work = await Promise.all(Array.from({ length: 2 }, () => processGatewayReconciliation(pool, gateway)));
      assert.equal(work.filter(Boolean).length, 2);
      assert.equal(lookups, 2);
      assert.equal(seen.size, 2);
      const journal = await pool.query(
        'SELECT COUNT(*)::int AS n FROM gateway_payment_journal j JOIN gateway_demo_purchases p USING (request_id) WHERE p.payer = $1',
        [payer2],
      );
      assert.equal(journal.rows[0]?.n, 2);
      assert.deepEqual(new Set(purchases.map((p) => p.nonce)), seen);

      // Two merchants coexist: each keeps its own payout address and network.
      const merchants = await pool.query(
        'SELECT recipient, network FROM gateway_merchants ORDER BY created_at',
      );
      assert.equal(merchants.rowCount, 2);
      assert.deepEqual(merchants.rows.map((r) => r.recipient).sort(), [recipient, recipient2].sort());
      assert.ok(merchants.rows.every((r) => r.network === 'arcTestnet'));
      const grantMerchant = await pool.query(
        'SELECT merchant_id FROM gateway_task_grants WHERE task_id = $1', [taskId2],
      );
      assert.ok(grantMerchant.rows[0]?.merchant_id);
    }

    const batchHash = `0x${'b'.repeat(64)}` as const;
    const depositHash = `0x${'d'.repeat(64)}` as const;
    const batchId = `0x${'a'.repeat(64)}` as const;
    let delta = -1000n;
    const chain: GatewayBalanceChain = {
      network: 'arcTestnet',
      finalized: async () => 12n,
      blockHash: async () => batchId,
      totalBalance: async (_wallet, block) => block === 9n ? 5000n : 8000n + delta,
      receiptBlock: async () => 11n,
      movements: async () => ({
        deposits: [{ hash: depositHash, logIndex: 1, amount: 3000n }],
        withdrawals: [],
        burns: [],
        batches: [{ hash: batchHash, id: batchId, delta }],
      }),
    };
    const pendingGateway: typeof fetch = async (url) => {
      assert.equal(new URL(String(url)).searchParams.get('nonce'), uncertain.nonce);
      return Response.json({ transfers: [{ id: randomUUID(), status: 'received', nonce: uncertain.nonce,
        fromAddress: payer, toAddress: recipient, token: 'USDC', sendingNetwork: arcGatewayNetwork,
        recipientNetwork: arcGatewayNetwork, amount: '1000', txHash: null }] });
    };
    const report = () => reconcileGatewayBalances(pool, chain, payer as `0x${string}`, 10n, 11n, pendingGateway);
    const matched = await report();
    assert.equal(matched.status, 'MATCHED');
    assert.equal(matched.balance.closing, '7000');
    assert.equal(matched.balance.journalDifference, '0');
    assert.equal(matched.currentAuthorizations.pendingAmount, '1000');
    assert.equal(matched.currentAuthorizations.unresolved[0]?.requestId, uncertain.id);
    delta = -1200n;
    const mismatch = await report();
    assert.equal(mismatch.status, 'DISCREPANCY');
    assert.equal(mismatch.balance.chainDifference, '0');
    assert.equal(mismatch.balance.journalDifference, '-200');
    assert.equal(mismatch.batches[0]?.status, 'DISCREPANCY');
    assert.deepEqual(await counters(), { reserved: '1000', spent: '1000' });
  });

  await t.test('Arc buyer recovers lost delivery by nonce without resubmitting payment', async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const origin = 'http://127.0.0.1:3002';
    const seeded = await seedGateway(pool, { origin, payer: payer.address, recipient }, 2000, 2000);
    const task = { taskId: seeded.taskId, agentToken: seeded.token };
    const financeToken = randomUUID();
    const operationsToken = randomUUID();
    const finance = buildApp(pool, false, undefined, financeToken, false, operationsToken);
    const headers = { authorization: `Bearer ${financeToken}` };
    const operations = { authorization: `Bearer ${operationsToken}` };
    const queueUrl = '/finance/gateway-purchases/review-queue';
    const reviewQueue = async () => {
      const response = await finance.inject({ url: queueUrl, headers: operations });
      assert.equal(response.statusCode, 200);
      return response.json() as { id: string; reason: string }[];
    };
    let submissions = 0;
    let signatures = 0;
    const merchant = buildGatewayMerchant(pool, origin, recipient, async (url, init) => {
      ++submissions;
      assert.equal(String(url), 'https://gateway-api-testnet.circle.com/v1/x402/settle');
      const { paymentPayload, paymentRequirements } = JSON.parse(String(init?.body));
      const nonce = paymentPayload.payload.authorization.nonce;
      const saved = await pool.query('SELECT nonce FROM gateway_demo_purchases WHERE nonce = $1', [nonce]);
      assert.equal(saved.rowCount, 1);
      assert.equal(paymentRequirements.network, arcGatewayNetwork);
      assert.equal(paymentRequirements.amount, '1000');
      return Response.json({
        success: true, transaction: randomUUID(), network: arcGatewayNetwork, payer: payer.address,
      });
    });
    const sign: Parameters<typeof purchaseGatewayTrace>[2] = (data) => {
      ++signatures;
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
      return new Response(response.body, {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
      });
    };
    const makePurchase = (requestId = randomUUID()) => ({
      requestId, payer: payer.address, recipient, endpoint: `${origin}/trace/${requestId}`, task,
    });
    const budget = async () => (await pool.query('SELECT reserved, spent FROM research_tasks WHERE id = $1', [task.taskId])).rows[0];
    try {
      const purchase = makePurchase();
      await Promise.all([
        purchaseGatewayTrace(pool, purchase, sign, send),
        purchaseGatewayTrace(pool, purchase, sign, send),
      ]);
      const delivered = await purchaseGatewayTrace(pool, purchase, sign, send);
      assert.equal(delivered.status, 'delivered');
      assert.equal(submissions, 1);
      assert.equal(signatures, 1);

      const interrupted = makePurchase();
      const lost = await purchaseGatewayTrace(pool, interrupted, sign, async (url, init) => {
        const response = await send(url, init);
        if (new Headers(init?.headers).has('payment-signature')) throw new Error('Lost paid response');
        return response;
      });
      assert.equal(lost.status, 'submission-unknown');
      assert.deepEqual(await budget(), { reserved: '2000', spent: '0' });
      await assert.rejects(purchaseGatewayTrace(pool, makePurchase(), sign, send), /TASK_BUDGET_EXCEEDED/);
      const transferId = randomUUID();
      const gateway: typeof fetch = async (url) => {
        assert.equal(new URL(String(url)).searchParams.get('nonce'), lost.nonce);
        return Response.json({ transfers: [{
          id: transferId, txHash: `0x${'b'.repeat(64)}`, status: 'confirmed',
          nonce: lost.nonce, fromAddress: payer.address, toAddress: recipient,
          token: 'USDC', sendingNetwork: arcGatewayNetwork, recipientNetwork: arcGatewayNetwork, amount: '1000',
        }] });
      };
      const unavailable = await purchaseGatewayTrace(pool, interrupted, sign, send, async () => {
        throw new Error('Gateway unavailable');
      });
      assert.equal(unavailable.status, 'submission-unknown');
      assert.deepEqual(unavailable.payment, { status: 'unavailable', reason: 'Gateway unavailable' });
      const notFound = await purchaseGatewayTrace(pool, interrupted, sign, send, async () =>
        Response.json({ transfers: [] }));
      assert.deepEqual(notFound.payment, { status: 'unknown' });
      assert.deepEqual(await budget(), { reserved: '2000', spent: '0' });
      const wrongToken = await send(interrupted.endpoint, {
        method: 'GET', headers: { 'trace-retrieval-token': 'a'.repeat(64) },
      });
      assert.equal(wrongToken.status, 404);
      const artifactUnavailable: typeof fetch = async (_url, init) => {
        assert.equal(init?.method, 'GET');
        return new Response(null, { status: 404 });
      };
      const missingDeliveries = await Promise.all([1, 2].map(() =>
        purchaseGatewayTrace(pool, interrupted, sign, artifactUnavailable, gateway)));
      assert.ok(missingDeliveries.every(({ status }) => status === 'charged-delivery-missing'));
      const financeUrl = `/finance/gateway-purchases/${interrupted.requestId}`;
      assert.equal((await finance.inject({ url: financeUrl })).statusCode, 401);
      assert.equal((await finance.inject({ url: queueUrl, headers: { authorization: `Bearer ${seeded.token}` } })).statusCode, 401);
      assert.deepEqual((await finance.inject({ url: '/finance/session', headers: operations })).json(),
        { role: 'operations' });
      assert.equal((await finance.inject({ url: '/finance/payment-intents', headers: operations })).statusCode, 403);
      assert.equal((await finance.inject({
        method: 'POST', url: `/finance/payment-intents/${interrupted.requestId}/testnet-refund`, headers: operations,
      })).statusCode, 403);
      assert.equal((await finance.inject({
        method: 'POST', url: `/finance/payment-intents/${interrupted.requestId}/refund-decision`,
        headers: operations, payload: { decision: 'APPROVED' },
      })).statusCode, 403);
      const queued = await reviewQueue();
      const missingIndex = queued.findIndex(({ id }) => id === interrupted.requestId);
      assert.equal(queued[missingIndex]?.reason, 'charged-delivery-missing');
      assert.ok(queued.findIndex(({ reason }) => reason === 'checks-paused') > missingIndex);
      assert.equal((await finance.inject({ method: 'POST', url: financeUrl + '/check' })).statusCode, 401);
      const audit = (await finance.inject({ url: financeUrl, headers: operations })).json();
      assert.equal(audit.buyerHasDelivery, false);
      assert.equal(audit.sellerHasDelivery, true);
      assert.equal(audit.nonce, lost.nonce);
      assert.equal(audit.budgetStatus, 'spent');
      assert.equal(audit.journal.transferId, transferId);
      assert.deepEqual(audit.journal.lines.map((line: { side: string }) => line.side), ['DEBIT', 'CREDIT']);
      assert.deepEqual(audit.observations.map(({ evidence }: { evidence: { status: string } }) => evidence.status),
        ['charged', 'charged', 'unknown', 'unavailable']);
      assert.equal(audit.retrieval_token, undefined);
      assert.equal(audit.delivery, undefined);
      assert.equal((await finance.inject({ method: 'POST', url: financeUrl + '/triage' })).statusCode, 401);
      const triageMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
      try {
        const triaged = await finance.inject({ method: 'POST', url: financeUrl + '/triage', headers: operations });
        assert.equal(triaged.statusCode, 200);
        assert.equal(triaged.json().rules.action, 'retrieve-delivery');
      } finally {
        triageMock.mock.restore();
      }
      assert.deepEqual((await finance.inject({ url: financeUrl, headers: operations })).json().observations,
        audit.observations);

      const fetchMock = t.mock.method(globalThis, 'fetch', gateway);
      try {
        const checks = await Promise.all([headers, operations].map((headers) =>
          finance.inject({ method: 'POST', url: financeUrl + '/check', headers })));
        for (const checked of checks) {
          assert.equal(checked.statusCode, 200);
          assert.equal(checked.json().status, 'charged');
        }
        assert.equal(fetchMock.mock.callCount(), 2);
      } finally {
        fetchMock.mock.restore();
      }
      const history = (await finance.inject({ url: financeUrl, headers })).json();
      assert.deepEqual(history.observations.slice(0, 2).map(({ source }: { source: string }) => source).sort(),
        ['finance', 'operations']);
      assert.deepEqual(await budget(), { reserved: '1000', spent: '1000' });
      const journal = await pool.query('SELECT request_id FROM gateway_payment_journal WHERE request_id = $1', [interrupted.requestId]);
      assert.equal(journal.rowCount, 1);

      const recovered = await purchaseGatewayTrace(pool, interrupted, sign, send, gateway);
      assert.equal(recovered.status, 'delivered');
      assert.equal(recovered.payment?.status, 'charged');
      assert.equal(recovered.nonce, lost.nonce);
      assert.deepEqual((await purchaseGatewayTrace(pool, interrupted, sign, send)).delivery, recovered.delivery);
      assert.equal((await finance.inject({ url: financeUrl, headers })).json().buyerHasDelivery, true);
      // The recovered fixture trace reports a reverted target transaction, which
      // is a correct diagnostic delivery under the commitment (which does not pin
      // 'success'), so it closes cleanly instead of surfacing for dispute review.
      const recoveredEntry = (await reviewQueue()).find(({ id }) => id === interrupted.requestId);
      assert.equal(recoveredEntry, undefined);
      const batchHash = `0x${'b'.repeat(64)}`;
      const verified = await collectGatewayPurchaseEvidence(pool, interrupted.requestId, async (hash) => {
        assert.equal(hash, batchHash);
        return { status: 'success', blockNumber: 42n };
      }, gateway);
      assert.equal(verified.status, 'PASSED');
      assert.deepEqual(verified.delivery, { buyerSaved: true, sellerSaved: true });
      assert.equal(verified.batch?.blockNumber, '42');
      assert.doesNotMatch(JSON.stringify(verified), /retrieval_token|execution reverted/);
      assert.equal((await collectGatewayPurchaseEvidence(pool, interrupted.requestId, async () => null, gateway)).status,
        'PENDING');
      assert.equal((await collectGatewayPurchaseEvidence(pool, interrupted.requestId, async () =>
        ({ status: 'reverted', blockNumber: 42n }), gateway)).status, 'FAILED');
      // A purchase whose stored delivery commitment is unsatisfied must fail the
      // overall verification, not pass with a mismatched detail view.
      await pool.query(
        `UPDATE gateway_demo_purchases SET commitment_satisfied = false, commitment_violations = $2 WHERE request_id = $1`,
        [interrupted.requestId, JSON.stringify(['trace.calls[0] type WRONG_TYPE != CALL'])]);
      const breached = await collectGatewayPurchaseEvidence(pool, interrupted.requestId, async () =>
        ({ status: 'success', blockNumber: 42n }), gateway);
      assert.equal(breached.status, 'FAILED');
      assert.ok(breached.problems.some((problem: string) => problem.includes('Delivery commitment not satisfied')));
      assert.equal(submissions, 2);
      assert.equal(signatures, 2);

      await assert.rejects(purchaseGatewayTrace(pool, makePurchase(), sign, async (url, init) => {
        const response = await send(url, init);
        const quote = JSON.parse(Buffer.from(response.headers.get('payment-required')!, 'base64').toString());
        quote.accepts[0].amount = '1001';
        return new Response(null, { status: 402, headers: {
          'payment-required': Buffer.from(JSON.stringify(quote)).toString('base64'),
        } });
      }), /quote differs/);
      assert.equal(signatures, 2);

      const uncharged = await seedGateway(pool, { origin, payer: payer.address, recipient }, 2000, 1000);
      const failure = { ...makePurchase(), task: { taskId: uncharged.taskId, agentToken: uncharged.token } };
      const lostBeforeMerchant = await purchaseGatewayTrace(pool, failure, sign, async (url, init) => {
        if (new Headers(init?.headers).has('payment-signature')) throw new Error('Lost paid request');
        return send(url, init);
      });
      await assert.rejects(purchaseGatewayTrace(pool, { ...makePurchase(), task: failure.task }, sign, send),
        /DAILY_LIMIT_EXCEEDED/);
      const rejected = await purchaseGatewayTrace(pool, failure, sign, send, async () =>
        Response.json({ transfers: [{
          id: randomUUID(), txHash: null, status: 'failed', nonce: lostBeforeMerchant.nonce,
          fromAddress: payer.address, toAddress: recipient, token: 'USDC',
          sendingNetwork: arcGatewayNetwork, recipientNetwork: arcGatewayNetwork, amount: '1000',
        }] }));
      assert.equal(rejected.status, 'payment-failed');
      const contradicted = await purchaseGatewayTrace(pool, failure, sign, send, async () =>
        Response.json({ transfers: [{
          id: randomUUID(), txHash: `0x${'c'.repeat(64)}`, status: 'confirmed', nonce: lostBeforeMerchant.nonce,
          fromAddress: payer.address, toAddress: recipient, token: 'USDC',
          sendingNetwork: arcGatewayNetwork, recipientNetwork: arcGatewayNetwork, amount: '1000',
        }] }));
      assert.equal(contradicted.status, 'reconciliation-conflict');
      await purchaseGatewayTrace(pool, failure, sign, send, async () => new Response(null, { status: 503 }));
      assert.equal((await reviewQueue())[0]?.id, failure.requestId);
      assert.equal((await reviewQueue())[0]?.reason, 'payment-conflict');
      const unchargedBudget = await pool.query('SELECT reserved, spent FROM research_tasks WHERE id = $1', [uncharged.taskId]);
      assert.deepEqual(unchargedBudget.rows[0], { reserved: '0', spent: '0' });

      const revoked = { ...makePurchase(), task: failure.task };
      await assert.rejects(purchaseGatewayTrace(pool, revoked, async (data) => {
        const signature = await sign(data);
        await pool.query('UPDATE research_tasks SET enabled = false WHERE id = $1', [uncharged.taskId]);
        return signature;
      }, send), /TASK_DISABLED_OR_EXPIRED/);
      const afterRevocation = await pool.query('SELECT reserved, spent FROM research_tasks WHERE id = $1', [uncharged.taskId]);
      assert.deepEqual(afterRevocation.rows[0], { reserved: '0', spent: '0' });
      assert.equal(submissions, 2);
    } finally {
      await Promise.all([merchant.close(), finance.close()]);
    }
  });

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
    const ledgerUrl = `/payment-intents/${(await pool.query(
      "SELECT intent_id FROM outbox WHERE event_type = 'payment.quoted'",
    )).rows[0]?.intent_id}/ledger`;
    const beforePosting = await app.inject({ url: ledgerUrl, headers });
    assert.equal(beforePosting.statusCode, 200);
    assert.equal(beforePosting.json().journal, null);
    assert.equal((await app.inject({
      url: ledgerUrl, headers: { authorization: `Bearer ${stranger.token}` },
    })).statusCode, 404);

    finalized = true;
    await pool.query('ALTER TABLE payment_journal ADD CONSTRAINT simulate_posting_failure CHECK (false)');
    try {
      await due();
      await processSettlement(pool, rail);
      assert.deepEqual(await state(), { status: 'UNKNOWN', transaction_hash: hash, reserved: '2000', spent: '0' });
      assert.equal((await app.inject({ url: ledgerUrl, headers })).json().journal, null);
    } finally {
      await pool.query('ALTER TABLE payment_journal DROP CONSTRAINT simulate_posting_failure');
    }
    await due();
    await processSettlement(pool, rail);
    assert.deepEqual(await state(), { status: 'SETTLED', transaction_hash: hash, reserved: '0', spent: '2000' });
    const result = await app.inject({ url: ledgerUrl, headers });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().journal.transactionHash, hash);
    assert.equal(result.json().journal.payer, from.toLowerCase());
    assert.deepEqual(result.json().journal.lines, [
      { account: 'DATA_PROCUREMENT_EXPENSE', side: 'DEBIT', amount: '2000' },
      { account: 'USDC_WALLET_ASSET', side: 'CREDIT', amount: '2000' },
    ]);
    assert.equal(await processSettlement(pool, rail), false);
    await pool.query("UPDATE outbox SET processed_at = NULL, available_at = now() WHERE event_type = 'payment.quoted'");
    await Promise.all([processSettlement(pool, rail), processSettlement(pool, rail)]);
    assert.equal((await pool.query('SELECT count(*) FROM payment_journal')).rows[0]?.count, '1');
    assert.deepEqual(await state(), { status: 'SETTLED', transaction_hash: hash, reserved: '0', spent: '2000' });
  });

  await t.test('finalized reconciliation matches once and reports discrepancies on both sides', async () => {
    const { rows: [posting] } = await pool.query(`
      SELECT j.payer, j.transaction_hash AS hash, i.payee AS recipient, j.amount
      FROM payment_journal j JOIN payment_intents i ON i.id = j.intent_id
    `);
    assert.ok(posting);
    const blockHash = `0x${'12'.repeat(32)}` as const;
    const extraHash = `0x${'cd'.repeat(32)}` as const;
    const matched = { transactionHash: posting.hash, logIndex: 1, recipient: posting.recipient, amount: BigInt(posting.amount) };
    const extra = { ...matched, transactionHash: extraHash, amount: 999n };
    let outgoing = [matched, matched];
    const chain: ReconciliationChain = {
      finalized: async () => 200n,
      blockHash: async () => blockHash,
      balanceAt: async (_wallet, block) => block === 149n ? 10000n : 8000n,
      outgoing: async () => outgoing,
      incoming: async () => [],
      transactionBlock: async () => 151n,
    };
    await assert.rejects(reconcilePayments(pool, chain, posting.payer, 150n, 201n), /finalized/);
    const first = await reconcilePayments(pool, chain, posting.payer, 150n, 160n);
    assert.equal(first.status, 'MATCHED');
    assert.equal(first.matched.length, 1);

    outgoing = [{ ...matched, amount: 2001n }, extra];
    const second = await reconcilePayments(pool, chain, posting.payer, 150n, 160n);
    assert.equal(second.status, 'DISCREPANCY');
    assert.equal(second.matched.length, 0);
    assert.deepEqual(second.discrepancies.map((item) => item.code).sort(), [
      'CHAIN_TRANSFER_UNMATCHED', 'CHAIN_TRANSFER_UNMATCHED', 'JOURNAL_TRANSFER_UNMATCHED',
    ]);
    const { rows: [stored] } = await pool.query('SELECT report FROM reconciliation_runs');
    assert.deepEqual(stored?.report, second);
    assert.equal((await pool.query('SELECT count(*) FROM reconciliation_runs')).rows[0]?.count, '1');

    outgoing = [];
    const outside = await reconcilePayments(pool, chain, posting.payer, 152n, 160n);
    assert.equal(outside.status, 'MATCHED');
    assert.equal(outside.matched.length, 0);
  });

  await t.test('the agent retrieves settled data through a merchant with independent proof verification', async () => {
    const { rows: [payment] } = await pool.query(`
      SELECT j.intent_id, j.payer, j.transaction_hash, i.payee, i.endpoint
      FROM payment_journal j JOIN payment_intents i ON i.id = j.intent_id
    `);
    assert.ok(payment);
    const config = { endpoint: payment.endpoint, recipient: payment.payee, secret: 'a'.repeat(32) };
    const blockHash = `0x${'12'.repeat(32)}` as const;
    let finalized = 99n;
    let amount = 2000n;
    let receiptReads = 0;
    const merchant = buildMerchant(pool, config, {
      finalized: async () => finalized,
      blockHash: async () => blockHash,
      receipt: async () => {
        receiptReads++;
        return { blockNumber: 100n, blockHash, transactionIndex: 0, status: 'success',
          logs: [{ address: baseSepoliaUsdc, from: payment.payer, to: payment.payee, amount, logIndex: 0 }] };
      },
    });
    const api = buildApp(pool, false, { merchant: config, fetcher: async (_, init) => {
      const response = await merchant.inject({
        method: 'POST', url: '/market-data',
        headers: Object.fromEntries(new Headers(init?.headers)), payload: String(init?.body),
      });
      return new Response(response.body, { status: response.statusCode });
    } });
    const url = `/payment-intents/${payment.intent_id}/delivery`;
    try {
      assert.ok((await merchant.inject('/market-data')).headers['payment-required']);
      const body = { intentId: payment.intent_id, payer: payment.payer, transactionHash: payment.transaction_hash };
      assert.equal((await merchant.inject({ method: 'POST', url: '/market-data', payload: body })).statusCode, 401);
      assert.equal((await api.inject({ method: 'POST', url, headers: { authorization: `Bearer ${stranger.token}` } })).statusCode, 404);
      assert.equal((await api.inject({ method: 'POST', url, headers })).statusCode, 502);
      finalized = 100n;
      amount = 1999n;
      assert.equal((await api.inject({ method: 'POST', url, headers })).statusCode, 502);
      amount = 2000n;
      const results = await Promise.all([api.inject({ method: 'POST', url, headers }), api.inject({ method: 'POST', url, headers })]);
      assert.equal(results[0]?.statusCode, 200);
      assert.deepEqual(results[0]?.json(), results[1]?.json());
      assert.equal(results[0]?.json().market, 'DE');
      const afterDelivery = receiptReads;
      assert.equal((await api.inject({ method: 'POST', url, headers })).statusCode, 200);
      assert.equal(receiptReads, afterDelivery);
      const reused = { ...body, intentId: randomUUID() };
      assert.equal((await merchant.inject({
        method: 'POST', url: '/market-data', payload: reused,
        headers: { 'delivery-signature': deliverySignature(config, reused) },
      })).statusCode, 409);
      assert.equal((await pool.query('SELECT count(*) FROM merchant_deliveries')).rows[0]?.count, '1');
    } finally {
      await Promise.all([merchant.close(), api.close()]);
    }
  });

  await t.test('only one finalized full merchant refund is posted for a payment', async () => {
    const { rows: [payment] } = await pool.query(`
      SELECT j.intent_id, j.payer, j.transaction_hash, i.payee, j.amount
      FROM payment_journal j JOIN payment_intents i ON i.id = j.intent_id
    `);
    assert.ok(payment);
    const refundHash = `0x${'de'.repeat(32)}` as const;
    const otherHash = `0x${'df'.repeat(32)}` as const;
    const blockHash = `0x${'12'.repeat(32)}` as const;
    let finalized = 110n;
    let amount = 1999n;
    let recipient = payment.payer;
    const chain: RefundChain = {
      finalized: async () => finalized,
      blockHash: async () => blockHash,
      receipt: async (hash) => ({
        blockNumber: hash === payment.transaction_hash ? 100n : 110n, blockHash,
        status: 'success', transactionIndex: 0,
        logs: [{ address: baseSepoliaUsdc, from: payment.payee, to: recipient, amount, logIndex: 3 }],
      }),
    };
    const submit = (hash = refundHash) => recordRefund(pool, chain, payment.intent_id, hash, 3, 'Delivery failed');
    await assert.rejects(submit(), /INVALID_REFUND_EVIDENCE/);
    amount = BigInt(payment.amount);
    recipient = '0x0000000000000000000000000000000000000002';
    await assert.rejects(submit(), /INVALID_REFUND_EVIDENCE/);
    recipient = payment.payer;
    finalized = 109n;
    await assert.rejects(submit(), /REFUND_NOT_FINALIZED/);
    finalized = 110n;

    const competing = await Promise.allSettled([submit(), submit(otherHash)]);
    const winner = competing.find((result) => result.status === 'fulfilled');
    const loser = competing.find((result) => result.status === 'rejected');
    assert.equal(winner?.status, 'fulfilled');
    assert.match(String(loser?.reason), /REFUND_ALREADY_RECORDED/);
    assert.deepEqual(await submit(winner.value.transactionHash === refundHash ? refundHash : otherHash), winner.value);
    assert.equal((await pool.query('SELECT count(*) FROM payment_refunds')).rows[0]?.count, '1');

    const outcome = await app.inject({ url: `/payment-intents/${payment.intent_id}/ledger`, headers });
    assert.equal(outcome.statusCode, 200);
    assert.equal(outcome.json().refund.transactionHash, winner.value.transactionHash);
    assert.deepEqual(outcome.json().refund.lines, [
      { account: 'USDC_WALLET_ASSET', side: 'DEBIT', amount: '2000' },
      { account: 'DATA_PROCUREMENT_EXPENSE', side: 'CREDIT', amount: '2000' },
    ]);
    assert.equal((await pool.query('SELECT spent FROM research_tasks WHERE id = $1', [buyer.taskId])).rows[0]?.spent, '2000');
  });

  await t.test('incoming refund reconciliation consumes only the exact recorded transfer', async () => {
    const { rows: [refund] } = await pool.query(`
      SELECT r.*, j.payer, j.amount, i.payee AS sender
      FROM payment_refunds r JOIN payment_journal j ON j.intent_id = r.intent_id
      JOIN payment_intents i ON i.id = r.intent_id
    `);
    assert.ok(refund);
    const transfer = {
      transactionHash: refund.transaction_hash, logIndex: refund.log_index, blockHash: refund.block_hash,
      blockNumber: BigInt(refund.block_number), sender: refund.sender, amount: BigInt(refund.amount),
    };
    let incoming = [transfer, transfer];
    const chain: ReconciliationChain = {
      finalized: async () => 120n,
      blockHash: async () => refund.block_hash,
      balanceAt: async (_wallet, block) => block === 110n ? transfer.amount : 0n,
      outgoing: async () => [],
      incoming: async () => incoming,
      transactionBlock: async () => 100n,
    };
    const reconcile = () => reconcilePayments(pool, chain, refund.payer, 110n, 110n);
    const matched = await reconcile();
    assert.equal(matched.status, 'MATCHED');
    assert.equal(matched.matchedRefunds.length, 1);
    assert.deepEqual(matched.refundDiscrepancies, []);

    incoming = [{ ...transfer, logIndex: transfer.logIndex + 1 }];
    const mismatch = await reconcile();
    assert.equal(mismatch.status, 'DISCREPANCY');
    assert.equal(mismatch.matchedRefunds.length, 0);
    assert.deepEqual(mismatch.refundDiscrepancies.map(({ code }) => code), [
      'REFUND_TRANSFER_UNMATCHED', 'UNCLASSIFIED_INCOMING_TRANSFER',
    ]);

    incoming = [{ ...transfer, amount: transfer.amount - 1n }];
    assert.equal((await reconcile()).status, 'DISCREPANCY');
    incoming = [transfer];
    const restored = await reconcile();
    assert.deepEqual(restored, matched);
    const { rows } = await pool.query('SELECT report FROM reconciliation_runs WHERE from_block = 110 AND to_block = 110');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.report, restored);
  });

  await t.test('wallet balance reconciliation separates missing journal entries from missing RPC logs', async () => {
    const { rows: [refund] } = await pool.query(`
      SELECT r.*, j.payer, j.amount, j.transaction_hash AS payment_hash, i.payee AS sender
      FROM payment_refunds r JOIN payment_journal j ON j.intent_id = r.intent_id
      JOIN payment_intents i ON i.id = r.intent_id
    `);
    assert.ok(refund);
    const fundingHash = `0x${'98'.repeat(32)}` as const;
    const unknownHash = `0x${'99'.repeat(32)}` as const;
    const funding = { transactionHash: fundingHash, logIndex: 2, blockNumber: 95n,
      blockHash: refund.block_hash, sender: refund.sender, amount: 10000n };
    const refundLog = { ...funding, transactionHash: refund.transaction_hash, logIndex: refund.log_index,
      blockNumber: BigInt(refund.block_number), amount: BigInt(refund.amount) };
    let finalized = 94n;
    const fundingChain: RefundChain = {
      finalized: async () => finalized,
      blockHash: async () => refund.block_hash,
      receipt: async (hash) => {
        const log = hash === fundingHash ? funding : refundLog;
        return { blockNumber: log.blockNumber, blockHash: log.blockHash, transactionIndex: 0, status: 'success',
          logs: [{ address: baseSepoliaUsdc, from: log.sender, to: refund.payer,
            logIndex: log.logIndex, amount: log.amount }] };
      },
    };
    const post = () => recordFunding(pool, fundingChain, refund.payer, fundingHash, funding.logIndex, 'Test deposit');
    await assert.rejects(post(), /FUNDING_NOT_FINALIZED/);
    finalized = 120n;
    const [first, repeated] = await Promise.all([post(), post()]);
    assert.deepEqual(first, repeated);
    assert.deepEqual(first.journal.map(({ account, side, amount }) => ({ account, side, amount })), [
      { account: 'USDC_WALLET_ASSET', side: 'DEBIT', amount: '10000' },
      { account: 'USDC_FUNDING_SOURCE', side: 'CREDIT', amount: '10000' },
    ]);
    await assert.rejects(recordFunding(pool, fundingChain, refund.payer, refundLog.transactionHash,
      refundLog.logIndex, 'Refund misclassified as funding'), /FUNDING_TRANSFER_ALREADY_USED/);

    let incoming = [funding, funding, refundLog];
    let closing = 15000n;
    const chain: ReconciliationChain = {
      finalized: async () => finalized,
      blockHash: async () => refund.block_hash,
      balanceAt: async (_wallet, block) => {
        assert.ok(block === 94n || block === 110n);
        return block === 94n ? 5000n : closing;
      },
      incoming: async () => incoming,
      outgoing: async () => [{ transactionHash: refund.payment_hash, logIndex: 0,
        recipient: refund.sender, amount: refundLog.amount }],
      transactionBlock: async () => 100n,
    };
    const reconcile = (view = chain) => reconcilePayments(pool, view, refund.payer, 95n, 110n);
    const matched = await reconcile();
    assert.equal(matched.status, 'MATCHED');
    assert.deepEqual(matched.matchedFunding, [{ transactionHash: fundingHash, logIndex: funding.logIndex }]);
    assert.deepEqual(matched.balance, {
      status: 'MATCHED', openingBlock: '94', openingBlockHash: refund.block_hash, opening: '5000', closing: '15000',
      funding: '10000', payments: '2000', refunds: '2000', chainIncoming: '12000', chainOutgoing: '2000',
      ledgerClosing: '15000', transferClosing: '15000', ledgerDifference: '0', transferDifference: '0',
    });

    incoming = [funding, refundLog, { ...funding, transactionHash: unknownHash, amount: 7n }];
    closing += 7n;
    const unbooked = await reconcile();
    assert.equal(unbooked.status, 'DISCREPANCY');
    assert.equal(unbooked.balance.ledgerDifference, '7');
    assert.equal(unbooked.balance.transferDifference, '0');
    assert.equal(unbooked.refundDiscrepancies[0]?.code, 'UNCLASSIFIED_INCOMING_TRANSFER');

    incoming = [refundLog];
    closing = 15000n;
    const missingLog = await reconcile();
    assert.equal(missingLog.status, 'DISCREPANCY');
    assert.equal(missingLog.balance.ledgerDifference, '0');
    assert.equal(missingLog.balance.transferDifference, '10000');
    assert.equal(missingLog.fundingDiscrepancies[0]?.code, 'FUNDING_TRANSFER_UNMATCHED');

    let openingReads = 0;
    await assert.rejects(reconcile({ ...chain, blockHash: async (block) =>
      block === 94n && openingReads++ > 0 ? unknownHash : refund.block_hash }), /Finalized block hash changed/);
  });

  await t.test('research purchase survives a lost settlement response across real HTTP services', async () => {
    const merchantPort = await availablePort();
    const config = {
      endpoint: `http://127.0.0.1:${merchantPort}/market-data`,
      recipient: '0x0000000000000000000000000000000000000003',
      secret: randomBytes(32).toString('hex'),
    };
    const demo = await seed(pool, 3000, 3000, config);
    const { rail: signer } = createBaseSettlement('http://127.0.0.1:1', generatePrivateKey(), generatePrivateKey());
    const hash = `0x${'56'.repeat(32)}` as const;
    const blockHash = `0x${'78'.repeat(32)}` as const;
    let recorded: Authorization | undefined;
    let submissions = 0;
    let receiptReads = 0;
    let steps = 0;
    let active = true;
    const merchant = buildMerchant(pool, config, {
      finalized: async () => 101n,
      blockHash: async () => blockHash,
      receipt: async (tx) => {
        receiptReads++;
        assert.equal(tx, hash);
        assert.ok(recorded);
        return { blockNumber: 101n, blockHash, transactionIndex: 0, status: 'success',
          logs: [{ address: baseSepoliaUsdc, from: recorded.from, to: recorded.to,
            amount: BigInt(recorded.value), logIndex: 0 }] };
      },
    });
    const api = buildApp(pool, false, { merchant: config });
    const rail: SettlementRail = {
      head: async () => ({ block: 100n, timestamp: 1000n }),
      sign: signer.sign,
      observe: async (authorization) => recorded?.nonce === authorization.nonce
        ? { status: 'settled', hash } : { status: 'ready' },
      async submit(authorization) {
        submissions++;
        recorded = authorization;
        throw new Error('Simulated RPC response loss after debit');
      },
    };
    const previousJobs = await pool.query(`
      SELECT count(*) FROM outbox WHERE processed_at IS NULL AND event_type IN ('payment.reserved', 'payment.quoted')
    `);
    assert.equal(previousJobs.rows[0]?.count, '0');
    const loop = async () => {
      while (active && steps++ < 200) {
        await processQuote(pool);
        await processSettlement(pool, rail);
        // Advance the test retry clock without waiting for the production backoff.
        await pool.query(`
          UPDATE outbox o SET available_at = now()
          FROM payment_intents i WHERE i.id = o.intent_id AND i.task_id = $1 AND o.processed_at IS NULL
        `, [demo.taskId]);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    let workers: Promise<void> | undefined;
    try {
      await merchant.listen({ host: '127.0.0.1', port: merchantPort });
      const apiUrl = await api.listen({ host: '127.0.0.1', port: 0 });
      const input = { ...demo, apiUrl, requestId: randomUUID() };
      workers = loop();
      const chain: ReconciliationChain = {
        finalized: async () => 101n,
        blockHash: async () => blockHash,
        balanceAt: async (_wallet, block) => block === 100n ? 3000n : 1000n,
        transactionBlock: async () => 101n,
        incoming: async () => [],
        outgoing: async () => {
          assert.ok(recorded);
          return [{ transactionHash: hash, logIndex: 0, recipient: recorded.to, amount: BigInt(recorded.value) }];
        },
      };
      const evidence = await Promise.race([
        collectPurchaseEvidence(pool, chain, input, { maxPolls: 100, pollIntervalMs: 10 }),
        workers.then(() => { throw new Error('Demo workers stopped before purchase completed'); }),
      ]);
      assert.equal(evidence.status, 'PASSED');
      assert.equal(evidence.purchaseId, input.requestId);
      assert.equal(evidence.delivery.sample, true);
      assert.equal(evidence.ledger.journal.transactionHash, hash);
      assert.ok(evidence.transactionUrl.endsWith(`/tx/${hash}`));
      assert.equal(evidence.reconciliation.status, 'MATCHED');
      assert.equal(evidence.reconciliation.matched.length, 1);
      const duplicate = await collectPurchaseEvidence(pool, {
        ...chain,
        async outgoing(...args) {
          const logs = await chain.outgoing(...args);
          return [...logs, { ...logs[0]!, logIndex: 1 }];
        },
      }, input);
      assert.equal(duplicate.status, 'FAILED');
      assert.equal(duplicate.reconciliation.discrepancies[0]?.code, 'CHAIN_TRANSFER_UNMATCHED');
      assert.equal(submissions, 1);
      assert.equal(receiptReads, 1);
      assert.equal((await pool.query(
        'SELECT count(*) FROM payment_journal j JOIN payment_intents i ON i.id = j.intent_id WHERE i.task_id = $1',
        [demo.taskId],
      )).rows[0]?.count, '1');
    } finally {
      active = false;
      try {
        await workers;
      } finally {
        await Promise.all([merchant.close(), api.close()]);
      }
    }
  });

  await t.test('finance approval and merchant delivery cannot both win a settled order', async () => {
    const { rows: [template] } = await pool.query(`
      SELECT i.*, j.payer, t.agent_id FROM payment_intents i JOIN payment_journal j ON j.intent_id = i.id
      JOIN research_tasks t ON t.id = i.task_id WHERE i.task_id = $1
    `, [buyer.taskId]);
    assert.ok(template);
    const finance = randomBytes(32).toString('base64url');
    const api = buildApp(pool, false, undefined, finance);
    const localApi = buildApp(pool, false, undefined, finance, true);
    const config = { endpoint: template.endpoint, recipient: template.payee, secret: 'a'.repeat(32) };
    const block = `0x${'fe'.repeat(32)}` as const;
    let releaseReceipt: () => void = () => {};
    let awaitReceipt: Promise<void> = Promise.resolve();
    let receiptReached: () => void = () => {};
    const merchant = buildMerchant(pool, config, {
      finalized: async () => 200n,
      blockHash: async () => block,
      receipt: async () => {
        receiptReached();
        await awaitReceipt;
        return { blockNumber: 200n, blockHash: block, transactionIndex: 0, status: 'success',
          logs: [{ address: baseSepoliaUsdc, from: template.payer, to: template.payee, amount: 2000n, logIndex: 0 }] };
      },
    });

    async function fixture(suffix: string) {
      const id = randomUUID();
      const hash = `0x${suffix.repeat(32)}` as const;
      await pool.query(`
        INSERT INTO payment_intents (id, task_id, service_id, request_id, idempotency_key, status,
          policy_version, endpoint, network, asset, payee, amount, budget_day, quote, signed_authorization,
          transaction_hash, settled_at)
        SELECT $1, task_id, service_id, $1, $1::uuid::text, status,
          policy_version, endpoint, network, asset, payee, amount, budget_day, quote,
          jsonb_set(signed_authorization, '{nonce}', to_jsonb($2::text)), $2, settled_at
        FROM payment_intents WHERE id = $3
      `, [id, hash, template.id]);
      await pool.query(`
        INSERT INTO payment_journal (intent_id, network, asset, payer, transaction_hash, amount, settled_at)
        SELECT $1, network, asset, payer, $2, amount, settled_at FROM payment_journal WHERE intent_id = $3
      `, [id, hash, template.id]);
      const proof = { intentId: id, payer: template.payer, transactionHash: hash };
      return {
        id,
        request: (auth = headers, reason = 'Data unavailable') => api.inject({ method: 'POST',
          url: `/payment-intents/${id}/refund-request`, headers: auth, payload: { reason } }),
        decide: (auth = `Bearer ${finance}`, decision = 'APPROVED') => api.inject({ method: 'POST',
          url: `/finance/payment-intents/${id}/refund-decision`,
          headers: { authorization: auth }, payload: { decision } }),
        deliver: () => merchant.inject({ method: 'POST', url: '/market-data',
          headers: { 'delivery-signature': deliverySignature(config, proof) }, payload: proof }),
      };
    }

    try {
      const approvalWins = await fixture('a7');
      assert.equal((await approvalWins.request({ authorization: `Bearer ${stranger.token}` })).statusCode, 404);
      assert.equal((await approvalWins.request()).json().status, 'PENDING');
      assert.equal((await approvalWins.request()).json().status, 'PENDING');
      assert.equal((await approvalWins.request(headers, 'Different reason')).statusCode, 409);
      assert.equal((await approvalWins.decide(headers.authorization)).statusCode, 401);

      const financeHeaders = { authorization: `Bearer ${finance}` };
      const consolePage = await api.inject('/finance');
      assert.equal(consolePage.statusCode, 200);
      assert.match(consolePage.body, /Finance Console/);
      assert.equal((await api.inject('/finance/console.js')).statusCode, 200);
      const listUrl = '/finance/payment-intents';
      assert.equal((await api.inject({ url: listUrl, headers })).statusCode, 401);
      const listed = await api.inject({ url: listUrl, headers: financeHeaders });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json().find((order: { id: string }) => order.id === approvalWins.id)?.refundStatus, 'PENDING');
      const detailUrl = listUrl + '/' + approvalWins.id;
      assert.equal((await api.inject({ url: detailUrl, headers })).statusCode, 401);
      const details = await api.inject({ url: detailUrl, headers: financeHeaders });
      assert.equal(details.statusCode, 200);
      assert.equal(details.json().ledger.journal.lines.length, 2);
      assert.equal(details.json().order.refundReason, 'Data unavailable');
      const refundedId = (await pool.query('SELECT intent_id FROM payment_refunds LIMIT 1')).rows[0]?.intent_id;
      assert.ok(refundedId);
      const refunded = await api.inject({ url: listUrl + '/' + refundedId, headers: financeHeaders });
      assert.equal(refunded.statusCode, 200);
      assert.equal(refunded.json().ledger.refund.lines.length, 2);
      assert.ok(refunded.json().reconciliation.some((report: { refund: boolean; status: string }) =>
        report.refund && report.status === 'MATCHED'));

      awaitReceipt = new Promise<void>((resolve) => { releaseReceipt = resolve; });
      const receiptStarted = new Promise<void>((resolve) => { receiptReached = resolve; });
      const delivery = approvalWins.deliver();
      await receiptStarted;
      try {
        const decision = await approvalWins.decide();
        assert.equal(decision.json().status, 'APPROVED');
        assert.deepEqual((await approvalWins.decide()).json(), decision.json());
      } finally {
        releaseReceipt();
      }
      assert.equal((await delivery).json().code, 'REFUND_APPROVED');

      const deliveryWins = await fixture('a8');
      assert.equal((await deliveryWins.request()).json().status, 'PENDING');
      assert.equal((await deliveryWins.deliver()).statusCode, 200);
      assert.equal((await deliveryWins.decide()).json().code, 'PAYMENT_ALREADY_DELIVERED');
      assert.equal((await deliveryWins.decide(undefined, 'DENIED')).json().status, 'DENIED');
      assert.equal((await deliveryWins.deliver()).statusCode, 200);
      const { rows } = await pool.query('SELECT intent_id FROM merchant_deliveries WHERE intent_id IN ($1, $2)',
        [approvalWins.id, deliveryWins.id]);
      assert.deepEqual(rows, [{ intent_id: deliveryWins.id }]);

      const queueUrl = detailUrl + '/testnet-refund';
      assert.equal((await api.inject({ method: 'POST', url: queueUrl, headers })).statusCode, 401);
      assert.equal((await api.inject({
        method: 'POST', url: listUrl + '/' + deliveryWins.id + '/testnet-refund', headers: financeHeaders,
      })).statusCode, 409);
      const enqueue = () => api.inject({ method: 'POST', url: queueUrl, headers: financeHeaders });
      const enqueued = await Promise.all([enqueue(), enqueue()]);
      assert.deepEqual(enqueued.map((response) => response.statusCode), [202, 202]);
      assert.equal((await pool.query('SELECT count(*) FROM finance_refund_jobs')).rows[0]?.count, '1');

      let calls = 0;
      const failOnce = async (id: string, reason: string) => {
        calls++;
        assert.equal(id, approvalWins.id);
        assert.equal(reason, 'Data unavailable');
        throw new Error('Simulated worker interruption');
      };
      await Promise.all([processFinanceRefund(pool, failOnce), processFinanceRefund(pool, failOnce)]);
      assert.equal(calls, 1);
      const retry = await api.inject({ url: detailUrl, headers: financeHeaders });
      assert.equal(retry.json().order.refundExecutionError, 'REFUND_EXECUTION_INCOMPLETE');
      assert.equal((await enqueue()).statusCode, 202);
      assert.equal(await processFinanceRefund(pool, async (id, reason) => {
        calls++;
        assert.equal(id, approvalWins.id);
        assert.equal(reason, 'Data unavailable');
      }), true);
      assert.equal(calls, 2);
      assert.equal(await processFinanceRefund(pool, failOnce), false);

      const demoAction = (id: string, action: string, auth = financeHeaders, server = localApi) =>
        server.inject({ method: 'POST', url: listUrl + '/' + id + '/demo-' + action, headers: auth });
      assert.equal((await demoAction(approvalWins.id, 'refund')).statusCode, 404);
      assert.equal((await demoAction(approvalWins.id, 'refund', financeHeaders, api)).statusCode, 404);

      // Isolate the simulated actions from Base Sepolia orders.
      await pool.query("UPDATE payment_intents SET network = 'demo:local' WHERE id = ANY($1::uuid[])",
        [[approvalWins.id, deliveryWins.id]]);
      await pool.query("UPDATE payment_journal SET network = 'demo:local' WHERE intent_id = ANY($1::uuid[])",
        [[approvalWins.id, deliveryWins.id]]);
      await pool.query('DELETE FROM merchant_deliveries WHERE intent_id = $1', [deliveryWins.id]);
      assert.equal((await demoAction(approvalWins.id, 'refund', headers)).statusCode, 401);
      assert.equal((await demoAction(approvalWins.id, 'deliver')).statusCode, 409);
      assert.equal((await demoAction(deliveryWins.id, 'refund')).statusCode, 409);
      const executions = await Promise.all([
        demoAction(approvalWins.id, 'refund'), demoAction(approvalWins.id, 'refund'),
        demoAction(deliveryWins.id, 'deliver'), demoAction(deliveryWins.id, 'deliver'),
      ]);
      assert.deepEqual(executions.map((response) => response.statusCode), [200, 200, 200, 200]);
      assert.deepEqual(executions.map((response) => response.json().status),
        ['REFUNDED', 'REFUNDED', 'DELIVERED', 'DELIVERED']);
      const refund = await localApi.inject({ url: detailUrl, headers: financeHeaders });
      assert.equal(refund.json().ledger.refund.lines.length, 2);
      assert.equal(refund.json().reconciliation.length, 0);
      const delivered = await localApi.inject({ url: listUrl + '/' + deliveryWins.id, headers: financeHeaders });
      assert.ok(delivered.json().order.deliveredAt);
      assert.equal(delivered.json().ledger.refund, null);
    } finally {
      releaseReceipt();
      await Promise.all([api.close(), localApi.close(), merchant.close()]);
    }
  });
});
