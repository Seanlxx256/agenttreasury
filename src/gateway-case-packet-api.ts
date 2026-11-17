import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { assembleCasePacket, collectPacketSources, interpretPacketClaims, statementSources, type PacketStatements } from './gateway-case-packet.js';
import { PaymentError } from './payments.js';

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
    const snapshot = await collectPacketSources(pool, request.params.id);
    const interpretation = await interpretPacketClaims([...snapshot.sources, ...statementSources(request.body)], process.env.GATEWAY_CASE_PACKET_MODEL);
    const report = assembleCasePacket(snapshot, request.body, interpretation);
    const current = await collectPacketSources(pool, request.params.id);
    const savedReport = { ...report, staleAtCompletion: snapshot.fingerprint !== current.fingerprint, freshnessCheckedAt: current.capturedAt };
    const { rows: [saved] } = await pool.query(`INSERT INTO gateway_case_packets(request_id,actor,report)
      VALUES($1,$2,$3) RETURNING id::text AS "packetId",created_at AS "createdAt"`, [request.params.id, actor, savedReport]);
    return { ...saved, ...savedReport };
  });
  app.get<{ Params: { id: string } }>(path, { preHandler: async (request) => { authenticate(request); }, schema: { params } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { rows: [saved] } = await pool.query(`SELECT id::text AS "packetId",created_at AS "createdAt",report
      FROM gateway_case_packets WHERE request_id=$1 ORDER BY id DESC LIMIT 1`, [request.params.id]);
    if (!saved) throw new PaymentError(404, 'CASE_PACKET_NOT_FOUND');
    const current = await collectPacketSources(pool, request.params.id);
    return { ...saved.report, packetId: saved.packetId, createdAt: saved.createdAt,
      staleNow: saved.report.snapshot.fingerprint !== current.fingerprint, freshnessCheckedAt: current.capturedAt };
  });
}
