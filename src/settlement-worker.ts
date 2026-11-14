import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Address, Hash } from 'viem';
import { baseSepoliaUsdc } from './base-settlement.js';
import type { Authorization, SettlementRail } from './base-settlement.js';
import { resolveReservation } from './budget.js';
import { transaction } from './db.js';
import { postSettledPayment } from './ledger.js';

interface Job {
  id: string;
  intent_id: string;
  authorization: Authorization | null;
  status: string;
  transaction_hash: Hash | null;
  attempts: number;
}

export async function processSettlement(pool: Pool, rail: SettlementRail) {
  const lease = randomUUID();
  const { rows: [job] } = await pool.query<Job>(`
    WITH next AS (
      SELECT id FROM outbox WHERE event_type = 'payment.quoted'
        AND processed_at IS NULL AND available_at <= now()
      ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE outbox o SET lease_token = $1, attempts = attempts + 1,
        available_at = now() + interval '60 seconds'
      FROM next WHERE o.id = next.id RETURNING o.id, o.intent_id, o.attempts
    )
    SELECT c.*, p.status, p.transaction_hash, p.signed_authorization AS "authorization" FROM claimed c JOIN payment_intents p ON p.id = c.intent_id
  `, [lease]);
  if (!job) return false;
  if (job.status === 'SETTLED' || job.status === 'FAILED') {
    await pool.query('UPDATE outbox SET processed_at = now(), lease_token = NULL WHERE id = $1 AND lease_token = $2',
      [job.id, lease]);
    return true;
  }

  let authorization = job.authorization;
  if (!authorization) {
    const head = await rail.head();
    authorization = await transaction(pool, async (client) => {
      const ownsJob = await client.query(
        'SELECT id FROM outbox WHERE id = $1 AND lease_token = $2 AND processed_at IS NULL FOR UPDATE',
        [job.id, lease],
      );
      if (!ownsJob.rowCount) return null;

      const { rows: [intent] } = await client.query<{
        task_id: string; budget_day: string; amount: string; payee: Address;
        eligible: boolean; network: string; asset: string; validity: number;
      }>(`
        SELECT p.task_id, p.budget_day::text, p.amount, p.payee, p.network, p.asset,
          (p.quote->>'maxTimeoutSeconds')::int AS validity,
          (t.enabled AND t.active_until > statement_timestamp() AND a.enabled AND s.enabled
            AND s.endpoint = p.endpoint AND s.network = p.network AND s.asset = p.asset
            AND s.payee = p.payee AND s.price = p.amount) AS eligible
        FROM payment_intents p
        JOIN research_tasks t ON t.id = p.task_id JOIN agents a ON a.id = t.agent_id
        JOIN services s ON s.id = p.service_id
        WHERE p.id = $1 AND p.status = 'QUOTED' FOR UPDATE OF p, t FOR SHARE OF a, s
      `, [job.intent_id]);
      if (!intent) throw new Error('Missing quoted intent');
      const grant = await client.query(
        'SELECT 1 FROM task_services g JOIN payment_intents p ON p.task_id = g.task_id AND p.service_id = g.service_id WHERE p.id = $1 FOR SHARE OF g',
        [job.intent_id],
      );

      if (!intent.eligible || !grant.rowCount || intent.network !== 'eip155:84532' || intent.asset !== baseSepoliaUsdc) {
        await client.query("UPDATE payment_intents SET status = 'FAILED', reason = 'PAYMENT_POLICY_CHANGED' WHERE id = $1", [job.intent_id]);
        await resolveReservation(client, intent.task_id, intent.budget_day, intent.amount, false);
        await client.query('UPDATE outbox SET processed_at = now(), lease_token = NULL WHERE id = $1', [job.id]);
        return null;
      }

      const signed = await rail.sign(intent.payee, intent.amount, intent.validity, head);
      await client.query("UPDATE payment_intents SET status = 'AUTHORIZED', signed_authorization = $2 WHERE id = $1",
        [job.intent_id, signed]);
      return signed;
    });
  }
  if (!authorization) return true;

  let chainOutcomeKnown = false;
  try {
    const observation = await rail.observe(authorization, job.transaction_hash ?? undefined);
    if (observation.status === 'settled' || observation.status === 'expired') {
      chainOutcomeKnown = true;
      const hash = observation.status === 'settled' ? observation.hash : null;
      await transaction(pool, async (client) => {
        const ownsJob = await client.query(
          'SELECT id FROM outbox WHERE id = $1 AND lease_token = $2 AND processed_at IS NULL FOR UPDATE',
          [job.id, lease],
        );
        if (!ownsJob.rowCount) return;
        const { rows: [intent] } = await client.query<{ task_id: string; budget_day: string; amount: string }>(`
          UPDATE payment_intents SET status = $2, reason = $3, transaction_hash = COALESCE($4, transaction_hash),
            settled_at = CASE WHEN $2 = 'SETTLED' THEN now() END
          WHERE id = $1 AND status IN ('AUTHORIZED', 'SUBMITTED', 'UNKNOWN')
          RETURNING task_id, budget_day::text, amount
        `, [job.intent_id, hash ? 'SETTLED' : 'FAILED', hash ? null : 'AUTHORIZATION_EXPIRED', hash]);
        if (!intent) {
          const terminal = await client.query(
            "SELECT 1 FROM payment_intents WHERE id = $1 AND status IN ('SETTLED', 'FAILED')", [job.intent_id],
          );
          if (!terminal.rowCount) throw new Error('Missing active authorization');
        } else {
          await resolveReservation(client, intent.task_id, intent.budget_day, intent.amount, Boolean(hash));
          if (hash) await postSettledPayment(client, job.intent_id);
        }
        await client.query('UPDATE outbox SET processed_at = now(), lease_token = NULL WHERE id = $1', [job.id]);
      });
      return true;
    }
    if (observation.status === 'ready') {
      const hash = await rail.submit(authorization);
      await pool.query(`
        UPDATE payment_intents p SET status = 'SUBMITTED', transaction_hash = $3
        FROM outbox o WHERE o.id = $1 AND o.lease_token = $2 AND o.intent_id = p.id
          AND p.status IN ('AUTHORIZED', 'SUBMITTED', 'UNKNOWN')
      `, [job.id, lease, hash]);
    }
  } catch (error) {
    // Keep the reservation if either the chain result or the local commit failed.
    await pool.query(`
      UPDATE payment_intents p SET status = 'UNKNOWN'
      FROM outbox o WHERE o.id = $1 AND o.lease_token = $2 AND o.intent_id = p.id
          AND p.status IN ('AUTHORIZED', 'SUBMITTED', 'UNKNOWN')
    `, [job.id, lease]);
    console.warn(chainOutcomeKnown ? 'Failed to record settlement outcome' : 'Settlement result unknown', {
      intentId: job.intent_id, errorType: error instanceof Error ? error.name : 'unknown',
    });
  }

  await pool.query(`
    UPDATE outbox SET available_at = now() + $3::int * interval '1 second', lease_token = NULL
    WHERE id = $1 AND lease_token = $2 AND processed_at IS NULL
  `, [job.id, lease, Math.min(10 * job.attempts, 60)]);
  return true;
}
