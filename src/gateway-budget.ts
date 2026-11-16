import type { PoolClient } from 'pg';
import { resolveReservation } from './budget.js';
import { PaymentError, tokenDigest } from './payments.js';
import type { GatewayNetworkName } from './gateway-x402.js';

export type GatewayTaskCredentials = { taskId: string; agentToken: string };
export type GatewayPurchaseTerms = {
  requestId: string; endpoint: string; payer: string; recipient: string; network: GatewayNetworkName;
};

export async function lockGatewayGrant(
  client: PoolClient, credentials: GatewayTaskCredentials, terms: GatewayPurchaseTerms,
) {
  const { taskId, agentToken } = credentials;
  const { rows: [task] } = await client.query<{
    enabled: boolean; budget: string; daily_limit: string; reserved: string; spent: string;
  }>(`SELECT enabled, budget, daily_limit, reserved, spent
      FROM research_tasks WHERE id = $1 FOR UPDATE`, [taskId]);
  const { rows: [grant] } = await client.query<{
    origin: string; payer: string; recipient: string; network: GatewayNetworkName; merchantId: string | null;
    approvedRecipientVersion: number | null;
  }>(`SELECT g.origin, g.payer, g.recipient, g.network, g.merchant_id AS "merchantId",
            g.approved_recipient_version AS "approvedRecipientVersion"
     FROM research_tasks t JOIN agents a ON a.id = t.agent_id JOIN gateway_task_grants g ON g.task_id = t.id
     WHERE t.id = $1 AND a.token_digest = $2 AND a.enabled FOR SHARE OF a, g`,
    [taskId, tokenDigest(agentToken)],
  );
  if (!task || !grant) throw new PaymentError(403, 'GATEWAY_TASK_NOT_ALLOWED');
  if (terms.endpoint !== `${grant.origin}/trace/${terms.requestId}` ||
      terms.payer.toLowerCase() !== grant.payer || terms.recipient.toLowerCase() !== grant.recipient ||
      terms.network !== grant.network) {
    throw new PaymentError(403, 'GATEWAY_PAYMENT_TERMS_NOT_ALLOWED');
  }
  // A grant pinned to a merchant must still point at the merchant's current
  // payout address. A recipient change supersedes the grant: the agent must be
  // re-authorized for the new address rather than paying the superseded one.
  if (grant.merchantId) {
    const { rows: [merchant] } = await client.query<{ recipient: string; version: number }>(
      'SELECT recipient, recipient_change_version AS version FROM gateway_merchants WHERE id = $1 FOR SHARE', [grant.merchantId],
    );
    if (!merchant || merchant.recipient !== grant.recipient || merchant.version !== grant.approvedRecipientVersion) {
      throw new PaymentError(403, 'GATEWAY_RECIPIENT_SUPERSEDED');
    }
  }
  const { rows: [clock] } = await client.query<{ day: string; active: boolean }>(
    `SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date::text AS day,
            active_until > statement_timestamp() AS active
     FROM research_tasks WHERE id = $1`, [taskId],
  );
  if (!task.enabled || !clock?.active) throw new PaymentError(403, 'TASK_DISABLED_OR_EXPIRED');
  return { ...task, day: clock.day };
}

export async function checkGatewayBudget(
  client: PoolClient, taskId: string, task: Awaited<ReturnType<typeof lockGatewayGrant>>, amount: string,
) {
  const { rows: [daily] } = await client.query<{ reserved: string; spent: string }>(
    'SELECT reserved, spent FROM daily_spend WHERE task_id = $1 AND day = $2', [taskId, task.day],
  );
  const price = BigInt(amount);
  if (BigInt(task.reserved) + BigInt(task.spent) + price > BigInt(task.budget)) {
    throw new PaymentError(403, 'TASK_BUDGET_EXCEEDED');
  }
  if (BigInt(daily?.reserved ?? '0') + BigInt(daily?.spent ?? '0') + price > BigInt(task.daily_limit)) {
    throw new PaymentError(403, 'DAILY_LIMIT_EXCEEDED');
  }
}

export async function releaseUnsubmittedGatewayPurchase(
  client: PoolClient, requestId: string, nonce: string, taskId: string,
) {
  await client.query('SELECT id FROM research_tasks WHERE id = $1 FOR UPDATE', [taskId]);
  const { rows: [purchase] } = await client.query<{ day: string; amount: string }>(
    `DELETE FROM gateway_demo_purchases
     WHERE request_id = $1 AND nonce = $2 AND task_id = $3 AND budget_status = 'reserved' AND submitted_at IS NULL
     RETURNING budget_day::text AS day, amount_units::text AS amount`, [requestId, nonce, taskId],
  );
  if (purchase) await resolveReservation(client, taskId, purchase.day, purchase.amount, false);
}
