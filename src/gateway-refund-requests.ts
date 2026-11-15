import type { Pool, PoolClient } from 'pg';
import { recordAudit } from './audit.js';
import { transaction } from './db.js';
import { PaymentError } from './payments.js';

const requestColumns = `request_id AS "requestId", reason, status, requested_by AS "requestedBy",
  requested_at AS "requestedAt", decided_by AS "decidedBy", decided_at AS "decidedAt"`;

interface GatewayRefundRequest {
  requestId: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
}

async function readRequest(client: PoolClient | Pool, requestId: string) {
  const { rows: [request] } = await client.query<GatewayRefundRequest>(
    `SELECT ${requestColumns} FROM gateway_refund_requests WHERE request_id = $1`, [requestId],
  );
  return request;
}

// Gateway refunds follow the Base rail's approval semantics, but key off the
// batched charge (gateway_payment_journal) instead of a payment_intent. A
// refund can only be requested once the transfer is charged and the delivery
// is still missing — the exact "charged but nothing came back" failure mode.
export async function requestGatewayRefund(pool: Pool, requestId: string, agentId: string, note: string) {
  const reason = note.trim();
  if (!reason || reason.length > 500) throw new PaymentError(400, 'INVALID_REFUND_REASON');
  return transaction(pool, async (client) => {
    const { rows: [purchase] } = await client.query(
      `SELECT p.request_id, t.agent_id FROM gateway_demo_purchases p
       JOIN research_tasks t ON t.id = p.task_id
       WHERE p.request_id = $1 AND t.agent_id = $2`, [requestId, agentId],
    );
    if (!purchase) throw new PaymentError(404, 'GATEWAY_PURCHASE_NOT_FOUND');
    await client.query('SELECT request_id FROM gateway_payment_journal WHERE request_id = $1 FOR UPDATE', [requestId]);

    const previous = await readRequest(client, requestId);
    if (previous) {
      if (previous.reason !== reason) throw new PaymentError(409, 'REFUND_REQUEST_EXISTS');
      return previous;
    }
    const { rows: [state] } = await client.query(`
      SELECT EXISTS (SELECT 1 FROM gateway_payment_journal WHERE request_id = $1) AS charged,
        (p.delivery IS NOT NULL OR d.delivery IS NOT NULL) AS delivered,
        EXISTS (SELECT 1 FROM gateway_payment_refunds WHERE request_id = $1) AS refunded
      FROM gateway_demo_purchases p
      LEFT JOIN gateway_demo_deliveries d ON d.request_id = p.request_id AND d.nonce = p.nonce
      WHERE p.request_id = $1
    `, [requestId]);
    if (!state?.charged) throw new PaymentError(409, 'PAYMENT_NOT_CHARGED');
    if (state.refunded) throw new PaymentError(409, 'PAYMENT_REFUNDED');
    if (state.delivered) throw new PaymentError(409, 'PAYMENT_ALREADY_DELIVERED');
    const { rows: [request] } = await client.query<GatewayRefundRequest>(
      `INSERT INTO gateway_refund_requests (request_id, reason, requested_by) VALUES ($1, $2, $3)
       RETURNING ${requestColumns}`, [requestId, reason, agentId],
    );
    await recordAudit(client, {
      actor: agentId, action: 'gateway.refund.requested', entity: `gateway_refund_request:${requestId}`, stateAfter: 'PENDING',
    });
    return request!;
  });
}

export async function decideGatewayRefund(pool: Pool, requestId: string, decision: 'APPROVED' | 'DENIED') {
  return transaction(pool, async (client) => {
    await client.query('SELECT request_id FROM gateway_payment_journal WHERE request_id = $1 FOR UPDATE', [requestId]);
    const current = await readRequest(client, requestId);
    if (!current) throw new PaymentError(404, 'REFUND_REQUEST_NOT_FOUND');
    if (current.status === decision) return current;
    if (current.status !== 'PENDING') throw new PaymentError(409, 'REFUND_ALREADY_DECIDED');

    if (decision === 'APPROVED') {
      const { rows: [state] } = await client.query(`
        SELECT (p.delivery IS NOT NULL OR d.delivery IS NOT NULL) AS delivered,
          EXISTS (SELECT 1 FROM gateway_payment_refunds WHERE request_id = $1) AS refunded
        FROM gateway_demo_purchases p
        LEFT JOIN gateway_demo_deliveries d ON d.request_id = p.request_id AND d.nonce = p.nonce
        WHERE p.request_id = $1
      `, [requestId]);
      if (state?.delivered) throw new PaymentError(409, 'PAYMENT_ALREADY_DELIVERED');
      if (state?.refunded) throw new PaymentError(409, 'PAYMENT_REFUNDED');
    }
    const { rows: [updated] } = await client.query<GatewayRefundRequest>(`
      UPDATE gateway_refund_requests SET status = $2, decided_by = 'finance-operator', decided_at = now()
      WHERE request_id = $1 RETURNING ${requestColumns}
    `, [requestId, decision]);
    await recordAudit(client, {
      actor: 'finance-operator', action: 'gateway.refund.decided', entity: `gateway_refund_request:${requestId}`,
      stateBefore: current.status, stateAfter: decision,
    });
    return updated!;
  });
}
