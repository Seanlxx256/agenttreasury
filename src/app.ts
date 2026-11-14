import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createIntent, getIntent, PaymentError } from './payments.js';
import type { Purchase } from './payments.js';

const uuid = {
  type: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
} as const;

export function tokenDigest(token: string) {
  return createHash('sha256').update(token).digest();
}

export function buildApp(pool: Pool, logger = false) {
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
      const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE version = 3');
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

  return app;
}
