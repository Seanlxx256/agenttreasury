import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.js';
import { PaymentError } from './payments.js';

const requestColumns = `intent_id AS "intentId", reason, status, requested_by AS "requestedBy",
  requested_at AS "requestedAt", decided_by AS "decidedBy", decided_at AS "decidedAt"`;

interface RefundRequest {
  intentId: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
}

async function readRequest(client: PoolClient | Pool, intentId: string) {
  const { rows: [request] } = await client.query<RefundRequest>(
    `SELECT ${requestColumns} FROM refund_requests WHERE intent_id = $1`, [intentId],
  );
  return request;
}

// All changes that can prevent fulfillment take the payment journal row lock first.
export async function checkDelivery(client: PoolClient, intentId: string, hash: string, payer: string) {
  const { rows: [payment] } = await client.query(
    'SELECT transaction_hash, payer FROM payment_journal WHERE intent_id = $1 FOR UPDATE', [intentId],
  );
  if (!payment) return 'PAYMENT_NOT_SETTLED';
  if (payment.transaction_hash !== hash || payment.payer !== payer) return 'INVALID_PAYMENT_PROOF';
  const { rows: [state] } = await client.query(`
    SELECT EXISTS (SELECT 1 FROM payment_refunds WHERE intent_id = $1) AS refunded,
      EXISTS (SELECT 1 FROM refund_requests WHERE intent_id = $1 AND status = 'APPROVED')
      OR EXISTS (SELECT 1 FROM refund_authorizations WHERE intent_id = $1) AS refund_approved
  `, [intentId]);
  if (state?.refunded) return 'PAYMENT_REFUNDED';
  if (state?.refund_approved) return 'REFUND_APPROVED';
}

export async function requestRefund(pool: Pool, intentId: string, agentId: string, note: string) {
  const reason = note.trim();
  if (!reason || reason.length > 500) throw new PaymentError(400, 'INVALID_REFUND_REASON');
  return transaction(pool, async (client) => {
    const { rows: [intent] } = await client.query(
      `SELECT i.status FROM payment_intents i JOIN research_tasks t ON i.task_id = t.id
       WHERE i.id = $1 AND t.agent_id = $2`, [intentId, agentId],
    );
    if (!intent) throw new PaymentError(404, 'INTENT_NOT_FOUND');
    if (intent.status !== 'SETTLED') throw new PaymentError(409, 'PAYMENT_NOT_SETTLED');
    await client.query('SELECT intent_id FROM payment_journal WHERE intent_id = $1 FOR UPDATE', [intentId]);

    const previous = await readRequest(client, intentId);
    if (previous) {
      if (previous.reason !== reason) throw new PaymentError(409, 'REFUND_REQUEST_EXISTS');
      return previous;
    }
    const { rows: [state] } = await client.query(`
      SELECT EXISTS (SELECT 1 FROM merchant_deliveries WHERE intent_id = $1) AS delivered,
        EXISTS (SELECT 1 FROM payment_refunds WHERE intent_id = $1) AS refunded,
        EXISTS (SELECT 1 FROM refund_authorizations WHERE intent_id = $1) AS already_authorized
    `, [intentId]);
    if (state?.refunded) throw new PaymentError(409, 'PAYMENT_REFUNDED');
    if (state?.delivered) throw new PaymentError(409, 'PAYMENT_ALREADY_DELIVERED');
    if (state?.already_authorized) throw new PaymentError(409, 'REFUND_ALREADY_AUTHORIZED');
    const { rows: [request] } = await client.query<RefundRequest>(
      `INSERT INTO refund_requests (intent_id, reason, requested_by) VALUES ($1, $2, $3)
       RETURNING ${requestColumns}`, [intentId, reason, agentId],
    );
    return request!;
  });
}

export async function decideRefund(pool: Pool, intentId: string, decision: 'APPROVED' | 'DENIED') {
  return transaction(pool, async (client) => {
    await client.query('SELECT intent_id FROM payment_journal WHERE intent_id = $1 FOR UPDATE', [intentId]);
    const current = await readRequest(client, intentId);
    if (!current) throw new PaymentError(404, 'REFUND_REQUEST_NOT_FOUND');
    if (current.status === decision) return current;
    if (current.status !== 'PENDING') throw new PaymentError(409, 'REFUND_ALREADY_DECIDED');

    if (decision === 'APPROVED') {
      const { rows: [state] } = await client.query(`
        SELECT EXISTS (SELECT 1 FROM merchant_deliveries WHERE intent_id = $1) AS delivered,
          EXISTS (SELECT 1 FROM payment_refunds WHERE intent_id = $1) AS refunded
      `, [intentId]);
      if (state?.delivered) throw new PaymentError(409, 'PAYMENT_ALREADY_DELIVERED');
      if (state?.refunded) throw new PaymentError(409, 'PAYMENT_REFUNDED');
    }
    const { rows: [updated] } = await client.query<RefundRequest>(`
      UPDATE refund_requests SET status = $2, decided_by = 'finance-operator', decided_at = now()
      WHERE intent_id = $1 RETURNING ${requestColumns}
    `, [intentId, decision]);
    return updated!;
  });
}
