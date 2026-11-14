import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { resolveReservation } from './budget.js';
import { transaction } from './db.js';
import { QuoteError, requestQuote } from './quote.js';
import type { Quote, QuoteTarget } from './quote.js';

interface Job extends QuoteTarget {
  id: string;
  intent_id: string;
  attempts: number;
}

export async function processQuote(pool: Pool, fetcher = fetch) {
  const lease = randomUUID();
  const { rows: [job] } = await pool.query<Job>(`
    WITH next AS (
      SELECT id FROM outbox
      WHERE event_type = 'payment.reserved' AND processed_at IS NULL AND available_at <= now()
      ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE outbox o SET lease_token = $1, attempts = attempts + 1,
        available_at = now() + interval '30 seconds'
      FROM next WHERE o.id = next.id RETURNING o.id, o.intent_id, o.attempts
    )
    SELECT c.*, i.endpoint, i.network, i.asset, i.payee, i.amount
    FROM claimed c JOIN payment_intents i ON i.id = c.intent_id
  `, [lease]);
  if (!job) return false;

  let quote: Quote | undefined;
  let reason = 'QUOTE_ATTEMPTS_EXHAUSTED';
  if (job.attempts <= 3) {
    try {
      quote = await requestQuote(job, fetcher);
    } catch (error) {
      if (!(error instanceof QuoteError)) throw error;
      reason = error.code;
      if (error.retryable && job.attempts < 3) {
        await pool.query(`
          UPDATE outbox SET available_at = now() + $3::int * interval '1 second', lease_token = NULL
          WHERE id = $1 AND lease_token = $2 AND processed_at IS NULL
        `, [job.id, lease, 2 ** job.attempts]);
        return true;
      }
    }
  }

  await transaction(pool, async (client) => {
    const claimed = await client.query(
      'SELECT id FROM outbox WHERE id = $1 AND lease_token = $2 AND processed_at IS NULL FOR UPDATE',
      [job.id, lease],
    );
    if (claimed.rowCount === 0) return;

    const { rows: [intent] } = await client.query<{ task_id: string; budget_day: string }>(`
      UPDATE payment_intents SET status = $2, reason = $3, quote = $4
      WHERE id = $1 AND status = 'RESERVED' RETURNING task_id, budget_day::text
    `, [job.intent_id, quote ? 'QUOTED' : 'FAILED', quote ? null : reason, quote ?? null]);

    if (intent && quote) {
      await client.query("INSERT INTO outbox (intent_id, event_type) VALUES ($1, 'payment.quoted')", [job.intent_id]);
    } else if (intent) {
      await resolveReservation(client, intent.task_id, intent.budget_day, job.amount, false);
    }
    await client.query('UPDATE outbox SET processed_at = now(), lease_token = NULL WHERE id = $1', [job.id]);
  });
  return true;
}
