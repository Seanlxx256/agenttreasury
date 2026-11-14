import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { baseSepoliaUsdc } from './base-settlement.js';
import { PaymentError } from './payments.js';

export async function enqueueFinanceRefund(pool: Pool, intentId: string) {
  const { rows: [job] } = await pool.query(`
    INSERT INTO finance_refund_jobs (intent_id, reason)
    SELECT q.intent_id, q.reason FROM refund_requests q
    JOIN payment_intents i ON i.id = q.intent_id
    JOIN payment_journal j ON j.intent_id = q.intent_id
    WHERE q.intent_id = $1 AND q.status = 'APPROVED' AND i.status = 'SETTLED'
      AND j.network = 'eip155:84532' AND j.asset = $2
      AND NOT EXISTS (SELECT 1 FROM merchant_deliveries d WHERE d.intent_id = q.intent_id)
      AND NOT EXISTS (SELECT 1 FROM payment_refunds r WHERE r.intent_id = q.intent_id)
    ON CONFLICT (intent_id) DO UPDATE SET available_at = CASE
      WHEN finance_refund_jobs.finished_at IS NULL AND finance_refund_jobs.last_error IS NOT NULL
        AND finance_refund_jobs.lease_token IS NULL THEN now()
      ELSE finance_refund_jobs.available_at END
    RETURNING intent_id AS "intentId"
  `, [intentId, baseSepoliaUsdc]);
  if (!job) {
    const { rows: [recorded] } = await pool.query(
      "SELECT intent_id AS \"intentId\" FROM payment_refunds WHERE intent_id = $1 AND network = 'eip155:84532'",
      [intentId],
    );
    if (!recorded) throw new PaymentError(409, 'TESTNET_REFUND_NOT_ELIGIBLE');
    return { intentId: recorded.intentId, status: 'RECORDED' };
  }
  return { intentId: job.intentId, status: 'QUEUED' };
}

export async function processFinanceRefund(
  pool: Pool,
  run: (intentId: string, reason: string) => Promise<void>,
) {
  const lease = randomUUID();
  const { rows: [job] } = await pool.query<{ intent_id: string; reason: string }>(`
    WITH next AS (
      SELECT intent_id FROM finance_refund_jobs
      WHERE finished_at IS NULL AND available_at <= now()
      ORDER BY available_at, intent_id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE finance_refund_jobs j SET lease_token = $1, available_at = now() + interval '50 minutes',
      attempts = attempts + 1, last_error = NULL
    FROM next WHERE j.intent_id = next.intent_id RETURNING j.intent_id, j.reason
  `, [lease]);
  if (!job) return false;

  try {
    await run(job.intent_id, job.reason);
    await pool.query(`
      UPDATE finance_refund_jobs SET finished_at = now(), lease_token = NULL
      WHERE intent_id = $1 AND lease_token = $2
    `, [job.intent_id, lease]);
  } catch {
    await pool.query(`
      UPDATE finance_refund_jobs SET last_error = 'REFUND_EXECUTION_INCOMPLETE', lease_token = NULL,
        available_at = now() + interval '5 minutes'
      WHERE intent_id = $1 AND lease_token = $2
    `, [job.intent_id, lease]);
  }
  return true;
}

export async function runFinanceRefund(intentId: string, reason: string, signal: AbortSignal) {
  const script = fileURLToPath(new URL('./refund-send.js', import.meta.url));
  try {
    await promisify(execFile)(process.execPath, [script, intentId, reason], { signal, timeout: 45 * 60_000 });
  } catch (error) {
    // The CLI uses exit 2 for a recorded refund with reconciliation differences.
    if (!(error instanceof Error && 'code' in error && error.code === 2)) throw error;
  }
}
