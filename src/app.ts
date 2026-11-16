import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { registerFinanceConsole } from './finance-console.js';
import { deliverPayment } from './delivery.js';
import type { MerchantConfig } from './merchant.js';
import { decideRefund, requestRefund } from './refund-requests.js';
import { decideGatewayRefund, requestGatewayRefund } from './gateway-refund-requests.js';
import { raiseGatewayDeliveryDispute } from './gateway-delivery-disputes.js';
import { getPaymentLedger } from './ledger.js';
import { createIntent, getIntent, PaymentError, tokenDigest } from './payments.js';
import type { Purchase } from './payments.js';

const uuid = {
  type: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
} as const;

export { tokenDigest } from './payments.js';

export function buildApp(
  pool: Pool, logger = false, delivery?: { merchant: MerchantConfig; fetcher?: typeof fetch },
  financeToken?: string, localDemo = false, operationsToken?: string,
) {
  if (financeToken && financeToken === operationsToken) {
    throw new Error('Finance and Gateway operations tokens must be distinct');
  }
  const app = Fastify({
    logger,
    bodyLimit: 8192,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  async function authenticate(request: FastifyRequest) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!token) throw new PaymentError(401, 'UNAUTHORIZED');

    const { rows: [agent] } = await pool.query<{ id: string }>(
      'SELECT id FROM agents WHERE token_digest = $1 AND enabled', [tokenDigest(token)],
    );
    if (!agent) throw new PaymentError(401, 'UNAUTHORIZED');
    return agent.id;
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PaymentError) {
      if (error.statusCode === 401) reply.header('www-authenticate', 'Bearer');
      return reply.code(error.statusCode).send({ code: error.code });
    }
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' &&
        error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ code: 'INVALID_REQUEST' });
    }
    request.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({ code: 'INTERNAL_ERROR' });
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (request, reply) => {
    try {
      const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE version = 10');
      if (rowCount === 1) return { status: 'ready' };
    } catch (error) {
      request.log.warn({ err: error }, 'Database readiness check failed');
    }
    return reply.code(503).send({ status: 'unavailable' });
  });

  app.post<{ Body: Purchase; Headers: { 'idempotency-key': string } }>(
    '/payment-intents',
    {
      schema: {
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['taskId', 'serviceId', 'requestId'],
          properties: { taskId: uuid, serviceId: uuid, requestId: uuid },
        },
      },
    },
    async (request, reply) => {
      const agentId = await authenticate(request);
      const { intent, created } = await createIntent(
        pool, agentId, request.headers['idempotency-key'], request.body,
      );
      return reply.code(created ? 201 : 200)
        .header('location', `/payment-intents/${intent.id}`).send(intent);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/payment-intents/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } },
    async (request) => getIntent(pool, await authenticate(request), request.params.id),
  );

  app.get<{ Params: { id: string } }>(
    '/payment-intents/:id/ledger',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } },
    async (request) => getPaymentLedger(pool, await authenticate(request), request.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/payment-intents/:id/delivery',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } },
    async (request) => {
      const agentId = await authenticate(request);
      if (!delivery) throw new PaymentError(503, 'DELIVERY_NOT_CONFIGURED');
      return deliverPayment(pool, delivery.merchant, agentId, request.params.id, delivery.fetcher);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>('/payment-intents/:id/refund-request', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuid } },
      body: { type: 'object', required: ['reason'], additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
    },
  }, async (request) => requestRefund(pool, request.params.id, await authenticate(request), request.body.reason));

  function authenticateConsole(request: FastifyRequest) {
    if (!financeToken && !operationsToken) throw new PaymentError(503, 'FINANCE_NOT_CONFIGURED');
    const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!token) throw new PaymentError(401, 'UNAUTHORIZED');
    const digest = tokenDigest(token);
    if (financeToken && timingSafeEqual(digest, tokenDigest(financeToken))) return 'finance';
    if (operationsToken && timingSafeEqual(digest, tokenDigest(operationsToken))) return 'operations';
    throw new PaymentError(401, 'UNAUTHORIZED');
  }

  function authenticateFinance(request: FastifyRequest) {
    if (authenticateConsole(request) !== 'finance') throw new PaymentError(403, 'FINANCE_ROLE_REQUIRED');
  }

  registerFinanceConsole(app, pool, authenticateConsole, authenticateFinance, localDemo);

  app.post<{ Params: { id: string }; Body: { decision: 'APPROVED' | 'DENIED' } }>(
    '/finance/payment-intents/:id/refund-decision', {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        body: { type: 'object', required: ['decision'], additionalProperties: false,
          properties: { decision: { enum: ['APPROVED', 'DENIED'] } } },
      },
      preHandler: async (request) => authenticateFinance(request),
    }, async (request) => decideRefund(pool, request.params.id, request.body.decision),
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>('/gateway-purchases/:id/refund-request', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: uuid } },
      body: { type: 'object', required: ['reason'], additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
    },
  }, async (request) => requestGatewayRefund(pool, request.params.id, await authenticate(request), request.body.reason));

  app.post<{ Params: { id: string }; Body: { reason: string; evidence: Record<string, unknown> } }>(
    '/gateway-purchases/:id/dispute', {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        body: { type: 'object', required: ['reason', 'evidence'], additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 1, maxLength: 500 }, evidence: { type: 'object' } } },
      },
    }, async (request) => {
      const agentId = await authenticate(request);
      return raiseGatewayDeliveryDispute(pool, request.params.id, agentId, request.body.reason, request.body.evidence);
    },
  );

  app.post<{ Params: { id: string }; Body: { decision: 'APPROVED' | 'DENIED' } }>(
    '/finance/gateway-purchases/:id/refund-decision', {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        body: { type: 'object', required: ['decision'], additionalProperties: false,
          properties: { decision: { enum: ['APPROVED', 'DENIED'] } } },
      },
      preHandler: async (request) => authenticateFinance(request),
    }, async (request) => decideGatewayRefund(pool, request.params.id, request.body.decision),
  );

  return app;
}
