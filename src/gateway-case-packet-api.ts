import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { assembleCasePacket, collectPacketSources, interpretPacketClaims, statementSources, packetTopics, type PacketStatements } from './gateway-case-packet.js';
import { appendCasePacket, reviseCasePacket, type PacketReview } from './gateway-case-packet-revision.js';
import { readCasePacketEffort } from './gateway-case-packet-effort.js';
import { PaymentError } from './payments.js';
import { interpretStructuredClaims } from './gateway-claim-assessment.js';

export function registerGatewayCasePackets(app: FastifyInstance, pool: Pool,
  authenticate: (request: FastifyRequest) => 'operations' | 'finance') {
  const path = '/finance/gateway-purchases/:id/case-packet';
  const params = { type: 'object', additionalProperties: false, required: ['id'], properties: {
    id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } };
  app.post<{ Params: { id: string }; Body: PacketStatements }>(path, {
    preHandler: async (request) => { authenticate(request); }, schema: { params, body: {
      type: 'object', additionalProperties: false, required: ['customerStatement', 'merchantStatement'], properties: {
        customerStatement: { type: 'string', maxLength: 3000 }, merchantStatement: { type: 'string', maxLength: 3000 },
      } } },
  }, async (request, reply) => {
    const actor = authenticate(request); reply.header('cache-control', 'no-store');
    const existing = await pool.query('SELECT 1 FROM gateway_case_packets WHERE request_id=$1 LIMIT 1', [request.params.id]);
    if (existing.rowCount) throw new PaymentError(409, 'CASE_PACKET_VERSION_CONFLICT');
    const snapshot = await collectPacketSources(pool, request.params.id);
    const interpret = process.env.GATEWAY_CASE_PACKET_ANALYSIS === 'structured' ? interpretStructuredClaims : interpretPacketClaims;
    const interpretation = await interpret([...snapshot.sources, ...statementSources(request.body)], process.env.GATEWAY_CASE_PACKET_MODEL);
    const report = assembleCasePacket(snapshot, request.body, interpretation);
    const current = await collectPacketSources(pool, request.params.id);
    const savedReport = { ...report, staleAtCompletion: snapshot.fingerprint !== current.fingerprint, freshnessCheckedAt: current.capturedAt };
    return appendCasePacket(pool, request.params.id, actor, savedReport);
  });
  app.get<{ Params: { id: string } }>(path, { preHandler: async (request) => { authenticate(request); }, schema: { params } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { rows: [saved] } = await pool.query(`SELECT id::text AS "packetId",parent_id::text AS "parentPacketId",created_at AS "createdAt",report
      FROM gateway_case_packets WHERE request_id=$1 ORDER BY id DESC LIMIT 1`, [request.params.id]);
    if (!saved) throw new PaymentError(404, 'CASE_PACKET_NOT_FOUND');
    const current = await collectPacketSources(pool, request.params.id);
    return { ...saved.report, packetId: saved.packetId, parentPacketId: saved.parentPacketId, createdAt: saved.createdAt,
      staleNow: saved.report.snapshot.fingerprint !== current.fingerprint, freshnessCheckedAt: current.capturedAt };
  });

  app.post<{ Params: { id: string }; Body: PacketReview }>(path + '/revisions', {
    preHandler: async (request) => { authenticate(request); }, schema: { params, body: {
      type: 'object', additionalProperties: false, required: ['expectedPacketId', 'topics', 'note', 'supplements'], properties: {
        timing: { type: 'object', additionalProperties: false, required: ['origin', 'elapsedMs'], properties: {
          origin: { type: 'string', enum: ['interactive-declared', 'simulation-declared'] },
          elapsedMs: { anyOf: [{ type: 'integer', minimum: 0, maximum: 3600000 }, { type: 'null' }] },
        } },
        expectedPacketId: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' },
        topics: { type: 'array', uniqueItems: true, maxItems: 4, items: { type: 'string', enum: [...packetTopics] } },
        note: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' },
        supplements: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false,
          required: ['kind', 'reference', 'text'], properties: {
            kind: { type: 'string', enum: ['merchant-reply', 'customer-reply', 'operator-observation'] },
            reference: { type: 'string', minLength: 1, maxLength: 300, pattern: '\\S' },
            text: { type: 'string', minLength: 1, maxLength: 1500, pattern: '\\S' },
          } } },
      } } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store'); const actor = authenticate(request);
    const { rows: [parent] } = await pool.query('SELECT report FROM gateway_case_packets WHERE request_id=$1 AND id=$2',
      [request.params.id, request.body.expectedPacketId]);
    if (!parent) throw new PaymentError(404, 'CASE_PACKET_NOT_FOUND');
    const snapshot = await collectPacketSources(pool, request.params.id);
    const report = reviseCasePacket(parent.report, snapshot, request.body, actor);
    const current = await collectPacketSources(pool, request.params.id);
    return appendCasePacket(pool, request.params.id, actor, { ...report,
      staleAtCompletion: snapshot.fingerprint !== current.fingerprint, freshnessCheckedAt: current.capturedAt }, request.body.expectedPacketId);
  });
  app.get<{ Params: { id: string } }>(path + '/effort', {
    preHandler: async (request) => { authenticate(request); }, schema: { params },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const existing = await pool.query('SELECT 1 FROM gateway_case_packets WHERE request_id=$1 LIMIT 1', [request.params.id]);
    if (!existing.rowCount) throw new PaymentError(404, 'CASE_PACKET_NOT_FOUND');
    return readCasePacketEffort(pool, request.params.id);
  });
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(path + '/history', {
    preHandler: async (request) => { authenticate(request); }, schema: { params, querystring: {
      type: 'object', additionalProperties: false, properties: { before: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' } } } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { rows } = await pool.query(`SELECT id::text AS "packetId",parent_id::text AS "parentPacketId",created_at AS "createdAt",actor
      FROM gateway_case_packets WHERE request_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 21`,
    [request.params.id, request.query.before ?? null]);
    return { packets: rows.slice(0, 20), nextBefore: rows.length > 20 ? rows[19].packetId : null };
  });
  app.get<{ Params: { id: string; packetId: string } }>(path + '/history/:packetId', {
    preHandler: async (request) => { authenticate(request); }, schema: { params: { ...params, required: ['id', 'packetId'],
      properties: { ...params.properties, packetId: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' } } } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { rows: [saved] } = await pool.query(`SELECT id::text AS "packetId",parent_id::text AS "parentPacketId",created_at AS "createdAt",report
      FROM gateway_case_packets WHERE request_id=$1 AND id=$2`, [request.params.id, request.params.packetId]);
    if (!saved) throw new PaymentError(404, 'CASE_PACKET_NOT_FOUND');
    const current = await collectPacketSources(pool, request.params.id);
    return { ...saved.report, packetId: saved.packetId, parentPacketId: saved.parentPacketId, createdAt: saved.createdAt,
      historicalView: true, staleNow: saved.report.snapshot.fingerprint !== current.fingerprint, freshnessCheckedAt: current.capturedAt };
  });
}
