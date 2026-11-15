import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { enqueueFinanceRefund } from './finance-refunds.js';
import { executeDemoDecision } from './finance-demo.js';
import { getPaymentLedger } from './ledger.js';
import { checkGatewayPayment } from './gateway-payment-evidence.js';
import type { ExpectedGatewayPayment } from './gateway-reconciliation.js';
import { PaymentError } from './payments.js';

const orderFields = `i.id, i.task_id AS "taskId", i.amount::text, i.status, i.payee,
  i.transaction_hash AS "transactionHash", i.created_at AS "createdAt",
  i.network, q.status AS "refundStatus", q.reason AS "refundReason", q.decided_at AS "decidedAt",
  d.delivered_at AS "deliveredAt", r.transaction_hash AS "refundHash",
  a.transaction_hash AS "submittedRefundHash", f.last_error AS "refundExecutionError",
  (f.intent_id IS NOT NULL AND f.finished_at IS NULL) AS "refundJobPending",
  CASE WHEN r.intent_id IS NOT NULL THEN 'RECORDED'
       WHEN a.transaction_hash IS NOT NULL THEN 'SUBMITTED'
       WHEN f.lease_token IS NOT NULL THEN 'PROCESSING'
       WHEN f.intent_id IS NOT NULL THEN 'QUEUED' END AS "refundExecution"`;
const orders = `FROM payment_intents i
  LEFT JOIN refund_requests q ON q.intent_id = i.id
  LEFT JOIN merchant_deliveries d ON d.intent_id = i.id
  LEFT JOIN payment_refunds r ON r.intent_id = i.id
  LEFT JOIN refund_authorizations a ON a.intent_id = i.id
  LEFT JOIN finance_refund_jobs f ON f.intent_id = i.id`;

const paymentParams = { type: 'object', required: ['id'],
  properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } };

export function registerFinanceConsole(
  app: FastifyInstance, pool: Pool, authenticateConsole: (request: FastifyRequest) => 'finance' | 'operations',
  authenticate: (request: FastifyRequest) => void, localDemo: boolean,
) {
  async function gatewayPurchase(id: string) {
    const { rows: [purchase] } = await pool.query<ExpectedGatewayPayment & {
      issuedAt: Date; buyerHasDelivery: boolean; sellerHasDelivery: boolean;
      taskId: string | null; budgetStatus: string | null; journal: unknown;
      reviewRequired: boolean;
    }>(`
      SELECT p.nonce, p.payer, p.recipient, p.amount_units::text AS "amountUnits",
             p.task_id AS "taskId", p.budget_status AS "budgetStatus",
             (p.budget_status = 'reserved' AND p.reconcile_review_at IS NOT NULL) IS TRUE AS "reviewRequired",
             p.authorized_at AS "issuedAt", (p.delivery IS NOT NULL) AS "buyerHasDelivery",
             (d.delivery IS NOT NULL) AS "sellerHasDelivery",
             CASE WHEN j.request_id IS NOT NULL THEN jsonb_build_object(
               'transferId', j.transfer_id, 'batchHash', j.batch_hash, 'postedAt', j.posted_at,
               'lines', (SELECT jsonb_agg(jsonb_build_object('account', l.account, 'side', l.side,
                 'amount', l.amount::text) ORDER BY l.number)
                FROM gateway_payment_journal_lines l WHERE l.request_id = j.request_id)
             ) END AS journal
      FROM gateway_demo_purchases p
      LEFT JOIN gateway_demo_deliveries d ON d.request_id = p.request_id AND d.nonce = p.nonce
      LEFT JOIN gateway_payment_journal j ON j.request_id = p.request_id
      WHERE p.request_id = $1
    `, [id]);
    if (!purchase) throw new PaymentError(404, 'GATEWAY_PURCHASE_NOT_FOUND');
    return purchase;
  }

  app.get('/finance/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { role: authenticateConsole(request) };
  });

  app.get('/finance/gateway-purchases/review-queue', async (request, reply) => {
    authenticateConsole(request);
    reply.header('Cache-Control', 'no-store');
    const { rows } = await pool.query(`
      WITH cases AS (
        SELECT p.request_id AS id, p.amount_units::text AS "amountUnits", p.authorized_at AS "issuedAt",
          CASE
            WHEN latest.status = 'conflict' THEN 'payment-conflict'
            WHEN p.delivery IS NULL AND (p.budget_status = 'spent' OR latest.status = 'charged')
              THEN 'charged-delivery-missing'
            WHEN p.budget_status = 'reserved' AND p.reconcile_review_at IS NOT NULL THEN 'checks-paused'
          END AS reason
        FROM gateway_demo_purchases p
        LEFT JOIN LATERAL (
          SELECT evidence->>'status' AS status FROM gateway_payment_observations
          WHERE request_id = p.request_id AND evidence->>'status' IN ('charged', 'failed', 'conflict')
          ORDER BY id DESC LIMIT 1
        ) latest ON true
      )
      SELECT id, "amountUnits", "issuedAt", reason FROM cases WHERE reason IS NOT NULL
      ORDER BY CASE reason WHEN 'payment-conflict' THEN 1 WHEN 'charged-delivery-missing' THEN 2 ELSE 3 END,
               "issuedAt", id
      LIMIT 100
    `);
    return rows;
  });

  app.get<{ Params: { id: string } }>('/finance/gateway-purchases/:id', {
    preHandler: async (request) => { authenticateConsole(request); }, schema: { params: paymentParams },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params;
    const purchase = await gatewayPurchase(id);
    const { rows: observations } = await pool.query(`
      SELECT checked_at AS "checkedAt", source, evidence
      FROM gateway_payment_observations WHERE request_id = $1 ORDER BY id DESC LIMIT 10
    `, [id]);
    return { id, ...purchase, observations };
  });

  app.post<{ Params: { id: string } }>('/finance/gateway-purchases/:id/check', {
    schema: { params: paymentParams },
  }, async (request, reply) => {
    const role = authenticateConsole(request);
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params;
    return checkGatewayPayment(pool, id, await gatewayPurchase(id), role);
  });

  for (const [path, file, type] of [
    ['/finance', 'index.html', 'text/html'],
    ['/finance/console.css', 'console.css', 'text/css'],
    ['/finance/console.js', 'console.js', 'text/javascript'],
  ] as const) {
    app.get(path, async (_, reply) => {
      reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      reply.header('X-Content-Type-Options', 'nosniff');
      return reply.type(type + '; charset=utf-8').send(await readFile(new URL('../../console/' + file, import.meta.url)));
    });
  }

  app.get('/finance/payment-intents', { preHandler: async (request) => authenticate(request) }, async (_, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { rows } = await pool.query(`SELECT ${orderFields} ${orders} ORDER BY i.created_at DESC, i.id DESC LIMIT 100`);
    return rows;
  });

  app.get<{ Params: { id: string } }>('/finance/payment-intents/:id', {
    preHandler: async (request) => authenticate(request),
    schema: { params: paymentParams },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = request.params;
    const { rows: [order] } = await pool.query(`SELECT ${orderFields}, t.agent_id AS "agentId"
      ${orders} JOIN research_tasks t ON t.id = i.task_id WHERE i.id = $1`, [id]);
    if (!order) throw new PaymentError(404, 'INTENT_NOT_FOUND');
    const ledger = await getPaymentLedger(pool, order.agentId, id);
    const { rows: reconciliation } = await pool.query(`
      SELECT checked_at AS "checkedAt", to_block::text AS "toBlock",
        report->>'status' AS status,
        EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(report->'matched', '[]')) m WHERE m->>'intentId' = $1) AS payment,
        EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(report->'matchedRefunds', '[]')) m WHERE m->>'intentId' = $1) AS refund,
        EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(report->'discrepancies', '[]') ||
          COALESCE(report->'refundDiscrepancies', '[]')) m WHERE m->>'intentId' = $1) AS discrepancy
      FROM reconciliation_runs
      WHERE payer = $2 AND asset = $3 AND network = $4 AND (
        report @> jsonb_build_object('matched', jsonb_build_array(jsonb_build_object('intentId', $1::text))) OR
        report @> jsonb_build_object('matchedRefunds', jsonb_build_array(jsonb_build_object('intentId', $1::text))) OR
        report @> jsonb_build_object('discrepancies', jsonb_build_array(jsonb_build_object('intentId', $1::text))) OR
        report @> jsonb_build_object('refundDiscrepancies', jsonb_build_array(jsonb_build_object('intentId', $1::text))))
      ORDER BY checked_at DESC LIMIT 10
    `, [id, ledger.journal?.payer ?? null, ledger.journal?.asset ?? null, ledger.journal?.network ?? null]);
    return { order, ledger, reconciliation, localDemo };
  });

  app.post<{ Params: { id: string } }>('/finance/payment-intents/:id/testnet-refund', {
    preHandler: async (request) => authenticate(request),
    schema: { params: paymentParams },
  }, async (request, reply) => {
    const result = await enqueueFinanceRefund(pool, request.params.id);
    return reply.code(result.status === 'QUEUED' ? 202 : 200).send(result);
  });

  if (localDemo) {
    for (const action of ['refund', 'deliver'] as const) {
      app.post<{ Params: { id: string } }>(`/finance/payment-intents/:id/demo-${action}`, {
        preHandler: async (request) => authenticate(request),
        schema: { params: paymentParams },
      }, (request) => executeDemoDecision(pool, request.params.id, action));
    }
  }

}
