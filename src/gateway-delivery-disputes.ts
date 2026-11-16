import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { recordAudit } from './audit.js';
import { transaction } from './db.js';
import { PaymentError } from './payments.js';

const disputeColumns = `request_id AS "requestId", reason, evidence, status,
  raised_by AS "raisedBy", raised_at AS "raisedAt", decided_by AS "decidedBy", decided_at AS "decidedAt",
  delivery_assessment AS "deliveryAssessment"`;

interface GatewayDeliveryDispute {
  requestId: string;
  reason: string;
  evidence: Record<string, unknown>;
  status: 'OPEN' | 'REFUND_APPROVED' | 'REFUNDED' | 'DISMISSED';
  raisedBy: string;
  raisedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  deliveryAssessment: {
    commitment: Record<string, unknown>;
    satisfied: boolean;
    violations: string[];
  } | null;
}

async function readDispute(client: PoolClient | Pool, requestId: string) {
  const { rows: [dispute] } = await client.query<GatewayDeliveryDispute>(
    `SELECT ${disputeColumns} FROM gateway_delivery_disputes WHERE request_id = $1`, [requestId],
  );
  return dispute;
}

// A delivery dispute is the pay-then-verify failure mode: the payment is
// charged AND a delivery exists, but the buyer asserts the delivery content is
// wrong. It is deliberately distinct from a refund request, which requires the
// delivery to be missing. The evidence is an opaque structured assertion from
// the buyer — the dispute is arbitrated by a human, not by the machine, so the
// machine's job is to keep the claim auditable and the refund execution safe.
export async function raiseGatewayDeliveryDispute(
  pool: Pool, requestId: string, agentId: string, note: string, evidence: unknown,
) {
  const reason = note.trim();
  if (!reason || reason.length > 500) throw new PaymentError(400, 'INVALID_DISPUTE_REASON');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new PaymentError(400, 'INVALID_DISPUTE_EVIDENCE');
  }
  return transaction(pool, async (client) => {
    const { rows: [purchase] } = await client.query(
      `SELECT p.request_id, t.agent_id FROM gateway_demo_purchases p
       JOIN research_tasks t ON t.id = p.task_id
       WHERE p.request_id = $1 AND t.agent_id = $2`, [requestId, agentId],
    );
    if (!purchase) throw new PaymentError(404, 'GATEWAY_PURCHASE_NOT_FOUND');
    await client.query('SELECT request_id FROM gateway_payment_journal WHERE request_id = $1 FOR UPDATE', [requestId]);

    const previous = await readDispute(client, requestId);
    if (previous) {
      if (previous.reason !== reason || !isDeepStrictEqual(previous.evidence, evidence)) {
        throw new PaymentError(409, 'DISPUTE_EXISTS');
      }
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
    if (!state.delivered) throw new PaymentError(409, 'DELIVERY_MISSING_USE_REFUND');

    const { rows: [assessment] } = await client.query<{
      commitment: Record<string, unknown>; satisfied: boolean | null; violations: string[] | null;
    }>(
      `SELECT delivery_commitment AS "commitment", commitment_satisfied AS "satisfied",
              commitment_violations AS "violations"
       FROM gateway_demo_purchases WHERE request_id = $1`, [requestId],
    );
    const deliveryAssessment = assessment?.commitment ? {
      commitment: assessment.commitment,
      satisfied: assessment.satisfied ?? false,
      violations: assessment.violations ?? [],
    } : null;

    const { rows: [dispute] } = await client.query<GatewayDeliveryDispute>(
      `INSERT INTO gateway_delivery_disputes (request_id, reason, evidence, raised_by, delivery_assessment)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${disputeColumns}`,
      [requestId, reason, JSON.stringify(evidence), agentId, deliveryAssessment ? JSON.stringify(deliveryAssessment) : null],
    );
    await recordAudit(client, {
      actor: agentId, action: 'gateway.dispute.raised', entity: `gateway_delivery_dispute:${requestId}`, stateAfter: 'OPEN',
    });
    return dispute!;
  });
}

// REFUND approves a refund but does not move money; the dispute moves to
// REFUND_APPROVED and the onchain return is executed through the refund
// broadcast entry point, then confirmed through recordGatewayRefund which
// finishes the dispute. DISMISS closes the dispute without a refund.
export async function decideGatewayDeliveryDispute(pool: Pool, requestId: string, decision: 'REFUND' | 'DISMISS') {
  return transaction(pool, async (client) => {
    await client.query('SELECT request_id FROM gateway_payment_journal WHERE request_id = $1 FOR UPDATE', [requestId]);
    const current = await readDispute(client, requestId);
    if (!current) throw new PaymentError(404, 'DISPUTE_NOT_FOUND');
    if (current.status !== 'OPEN') throw new PaymentError(409, 'DISPUTE_ALREADY_DECIDED');
    const status = decision === 'REFUND' ? 'REFUND_APPROVED' : 'DISMISSED';
    const { rows: [updated] } = await client.query<GatewayDeliveryDispute>(`
      UPDATE gateway_delivery_disputes SET status = $2, decided_by = 'finance-operator', decided_at = now()
      WHERE request_id = $1 RETURNING ${disputeColumns}
    `, [requestId, status]);
    await recordAudit(client, {
      actor: 'finance-operator', action: 'gateway.dispute.decided', entity: `gateway_delivery_dispute:${requestId}`,
      stateBefore: current.status, stateAfter: status,
    });
    return updated!;
  });
}
