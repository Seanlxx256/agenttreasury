import type { Pool } from 'pg';
import { resolveReservation } from './budget.js';
import { transaction } from './db.js';
import { checkGatewayPayment } from './gateway-payment-evidence.js';
import type { ExpectedGatewayPayment } from './gateway-reconciliation.js';

const maxAttempts = 12;

type Claim = ExpectedGatewayPayment & {
  requestId: string; taskId: string; submitted: boolean; leaseUntil: string; attempts: number;
};

export async function processGatewayReconciliation(pool: Pool, request: typeof fetch = fetch) {
  const { rows: [claim] } = await pool.query<Claim>(`
    WITH candidate AS (
      SELECT request_id FROM gateway_demo_purchases
      WHERE budget_status = 'reserved' AND reconcile_review_at IS NULL AND reconcile_after <= now()
        AND (submitted_at IS NOT NULL OR authorized_at <= now() - interval '2 minutes')
      ORDER BY reconcile_after, request_id
      LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE gateway_demo_purchases p SET reconcile_after = now() + interval '30 seconds'
    FROM candidate WHERE p.request_id = candidate.request_id
    RETURNING p.request_id AS "requestId", p.task_id AS "taskId", p.nonce, p.payer, p.recipient,
              p.amount_units::text AS "amountUnits", p.network, p.submitted_at IS NOT NULL AS submitted,
              p.reconcile_after::text AS "leaseUntil", p.reconcile_attempts AS attempts
  `);
  if (!claim) return false;

  if (!claim.submitted) {
    await transaction(pool, async (client) => {
      await client.query('SELECT id FROM research_tasks WHERE id = $1 FOR UPDATE', [claim.taskId]);
      const { rows: [released] } = await client.query<{ day: string }>(`
        UPDATE gateway_demo_purchases SET budget_status = 'released'
        WHERE request_id = $1 AND nonce = $2 AND reconcile_after = $3::timestamptz
          AND budget_status = 'reserved' AND submitted_at IS NULL
        RETURNING budget_day::text AS day
      `, [claim.requestId, claim.nonce, claim.leaseUntil]);
      if (!released) return;
      await resolveReservation(client, claim.taskId, released.day, claim.amountUnits, false);
      await client.query(`
        INSERT INTO gateway_payment_observations (request_id, source, evidence)
        VALUES ($1, 'worker', '{"status":"submission-expired"}')
      `, [claim.requestId]);
    });
    return true;
  }

  const evidence = await checkGatewayPayment(pool, claim.requestId, claim, 'worker', request);
  const attempts = claim.attempts + 1;
  const review = evidence.status === 'conflict' || attempts >= maxAttempts;
  const delay = Math.min(300, 5 * 2 ** (attempts - 1));
  await pool.query(`
    UPDATE gateway_demo_purchases
    SET reconcile_attempts = $4, reconcile_after = now() + $5 * interval '1 second',
        reconcile_review_at = CASE WHEN $6 THEN now() END
    WHERE request_id = $1 AND nonce = $2 AND reconcile_after = $3::timestamptz AND budget_status = 'reserved'
  `, [claim.requestId, claim.nonce, claim.leaseUntil, attempts, delay, review]);
  return true;
}
