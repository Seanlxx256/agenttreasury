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
      j.posted_at AS "postedAt", j.account, j.side, j.amount,
      (SELECT jsonb_build_object(
        'transactionHash', r.transaction_hash, 'logIndex', r.log_index,
        'blockNumber', r.block_number::text, 'postedAt', r.posted_at, 'reason', r.reason,
        'lines', (SELECT jsonb_agg(jsonb_build_object('account', l.account, 'side', l.side,
          'amount', l.amount::text) ORDER BY l.number)
          FROM refund_journal_lines l WHERE l.intent_id = r.intent_id)
      ) FROM payment_refunds r WHERE r.intent_id = i.id) AS refund
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
    refund: entry.refund,
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
