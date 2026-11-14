import type { Pool, PoolClient } from 'pg';
import { PaymentError } from './payments.js';

export async function postSettledPayment(client: PoolClient, intentId: string) {
  const result = await client.query(`
    INSERT INTO payment_journal (intent_id, network, asset, payer, transaction_hash, amount, settled_at)
    SELECT id, network, asset, lower(signed_authorization->>'from'), lower(transaction_hash), amount, settled_at
    FROM payment_intents WHERE id = $1 AND status = 'SETTLED'
  `, [intentId]);
  if (result.rowCount !== 1) throw new Error('Expected one settled payment to post');
}

export async function getPaymentLedger(pool: Pool, agentId: string, intentId: string) {
  const { rows } = await pool.query(`
    SELECT i.id AS "intentId", i.status, j.network, j.asset, j.payer,
      j.transaction_hash AS "transactionHash", j.settled_at AS "settledAt",
      j.posted_at AS "postedAt", j.account, j.side, j.amount
    FROM payment_intents i
    JOIN research_tasks t ON t.id = i.task_id
    LEFT JOIN payment_journal_lines j ON j.intent_id = i.id
    WHERE i.id = $1 AND t.agent_id = $2
    ORDER BY j.number
  `, [intentId, agentId]);
  const [entry] = rows;
  if (!entry) throw new PaymentError(404, 'INTENT_NOT_FOUND');

  return {
    intentId: entry.intentId,
    status: entry.status,
    journal: entry.transactionHash === null ? null : {
      network: entry.network,
      asset: entry.asset,
      payer: entry.payer,
      transactionHash: entry.transactionHash,
      settledAt: entry.settledAt,
      postedAt: entry.postedAt,
      lines: rows.map(({ account, side, amount }) => ({ account, side, amount })),
    },
  };
}
