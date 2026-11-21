import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { gatewayOperationsMetrics, transitionGatewayCase } from './gateway-cases.js';
import { PaymentError } from './payments.js';
import type { OperationsCache } from './operations-cache.js';

const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const params = { type: 'object', required: ['id'], properties: { id: uuid } };

export function registerGatewayOperations(app: FastifyInstance, pool: Pool,
  authenticate: (request: FastifyRequest) => 'finance' | 'operations', cache?: OperationsCache) {
  app.get('/finance/operations/metrics', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    authenticate(request);
    if (cache) return cache.read(() => gatewayOperationsMetrics(pool));
    return { ...await gatewayOperationsMetrics(pool), cache: { source: 'disabled', ageMs: 0, ttlMs: 0 } };
  });
  app.get<{ Querystring: { status?: string; before?: string } }>('/finance/reconciliation-cases', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      status: { enum: ['open', 'investigating', 'resolved', 'all'] }, before: uuid,
    } } },
  }, async (request) => {
    authenticate(request);
    const { rows } = await pool.query(`SELECT * FROM gateway_reconciliation_cases
      WHERE ($1='all' OR ($1='unresolved' AND status<>'resolved') OR status=$1)
        AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT 101`,
    [request.query.status ?? 'unresolved', request.query.before ?? null]);
    return { cases: rows.slice(0, 100), next: rows.length > 100 ? rows[99].id : null };
  });
  app.get<{ Params: { id: string } }>('/finance/reconciliation-cases/:id', { schema: { params } }, async (request) => {
    authenticate(request);
    // A single snapshot binds the case version to its evidence and audit history.
    const { rows: [result] } = await pool.query(`SELECT c.*,
      (SELECT count(*)::int FROM gateway_balance_discrepancies WHERE case_id=c.id) AS "occurrenceCount",
      (SELECT row_to_json(d) FROM gateway_balance_discrepancies d WHERE d.id=c.latest_discrepancy_id) AS evidence,
      (SELECT coalesce(jsonb_agg(e ORDER BY e.id DESC),'[]'::jsonb) FROM
        (SELECT * FROM gateway_case_events WHERE case_id=c.id ORDER BY id DESC LIMIT 100) e) AS events
      FROM gateway_reconciliation_cases c WHERE c.id=$1`, [request.params.id]);
    if (!result) throw new PaymentError(404, 'CASE_NOT_FOUND');
    return result;
  });
  app.post<{ Params: { id: string }; Body: {
    expectedVersion: number; status: 'investigating' | 'resolved'; note: string; evidenceId: string;
  } }>('/finance/reconciliation-cases/:id/transitions', { schema: { params, body: {
    type: 'object', additionalProperties: false,
    required: ['expectedVersion', 'status', 'note', 'evidenceId'], properties: {
      expectedVersion: { type: 'integer', minimum: 1 }, status: { enum: ['investigating', 'resolved'] },
      note: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' }, evidenceId: uuid,
    },
  } } }, async (request) => {
    const role = authenticate(request);
    const result = await transitionGatewayCase(pool, request.params.id, request.body, role);
    request.log.info({ event: 'case_transition', caseId: result.id, version: result.version, role,
      status: result.status, evidenceId: request.body.evidenceId }, 'Reconciliation case updated');
    return result;
  });
}
