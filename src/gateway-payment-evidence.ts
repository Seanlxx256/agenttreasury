import type { Pool } from 'pg';
import { recordAudit } from './audit.js';
import { resolveReservation } from './budget.js';
import { transaction } from './db.js';
import { observeGatewayPayment, type ExpectedGatewayPayment, type GatewayObservation } from './gateway-reconciliation.js';

type CheckedPayment = GatewayObservation | { status: 'unavailable' } |
  { status: 'conflict'; reason: 'accounting-mismatch'; reported: GatewayObservation };

export async function checkGatewayPayment(
  pool: Pool,
  requestId: string,
  expected: ExpectedGatewayPayment,
  source: 'buyer' | 'finance' | 'operations' | 'worker',
  request: typeof fetch = fetch,
) {
  let evidence: CheckedPayment;
  try {
    evidence = await observeGatewayPayment(expected, request);
  } catch {
    evidence = { status: 'unavailable' };
  }
  return transaction(pool, async (client) => {
    const { rows: [owner] } = await client.query<{ task_id: string | null }>(
      'SELECT task_id FROM gateway_demo_purchases WHERE request_id = $1 AND nonce = $2', [requestId, expected.nonce],
    );
    if (owner?.task_id) {
      await client.query('SELECT id FROM research_tasks WHERE id = $1 FOR UPDATE', [owner.task_id]);
    }
    const { rows: [purchase] } = await client.query<{
      taskId: string | null; day: string; amount: string; submitted: boolean;
      budgetStatus: 'reserved' | 'spent' | 'released' | null;
    }>(`SELECT task_id AS "taskId", budget_day::text AS day, amount_units::text AS amount,
                budget_status AS "budgetStatus", submitted_at IS NOT NULL AS submitted
         FROM gateway_demo_purchases WHERE request_id = $1 AND nonce = $2 FOR UPDATE`, [requestId, expected.nonce]);
    if (!purchase) return evidence;

    if (purchase.taskId && (evidence.status === 'charged' || evidence.status === 'failed')) {
      const budgetStatus = evidence.status === 'charged' ? 'spent' : 'released';
      let accountingMatches = purchase.submitted &&
        (purchase.budgetStatus === 'reserved' || purchase.budgetStatus === budgetStatus);
      if (accountingMatches && evidence.status === 'charged') {
        if (purchase.budgetStatus === 'reserved') {
          const posted = await client.query(
            `INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [requestId, evidence.id, evidence.txHash, purchase.amount],
          );
          accountingMatches = posted.rowCount === 1;
        } else {
          const posted = await client.query(
            'SELECT 1 FROM gateway_payment_journal WHERE request_id = $1 AND transfer_id = $2 AND batch_hash = $3',
            [requestId, evidence.id, evidence.txHash],
          );
          accountingMatches = posted.rowCount === 1;
        }
      }
      if (!accountingMatches) evidence = { status: 'conflict', reason: 'accounting-mismatch', reported: evidence };
      else if (purchase.budgetStatus === 'reserved') {
        await resolveReservation(client, purchase.taskId, purchase.day, purchase.amount, budgetStatus === 'spent');
        await client.query('UPDATE gateway_demo_purchases SET budget_status = $2 WHERE request_id = $1',
          [requestId, budgetStatus]);
      }
    }

    await client.query('INSERT INTO gateway_payment_observations (request_id, source, evidence) VALUES ($1, $2, $3)',
      [requestId, source, JSON.stringify(evidence)]);
    await recordAudit(client, {
      actor: source, action: 'gateway.payment.observed', entity: `gateway_purchase:${requestId}`,
      stateAfter: evidence.status,
    });
    return evidence;
  });
}
