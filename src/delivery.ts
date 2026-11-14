import type { Pool } from 'pg';
import { baseSepoliaUsdc } from './base-settlement.js';
import { deliverySignature, marketNetwork, marketPrice } from './merchant.js';
import type { DeliveryProof, MerchantConfig } from './merchant.js';
import { PaymentError } from './payments.js';

export async function deliverPayment(
  pool: Pool, config: MerchantConfig, agentId: string, intentId: string, fetcher = fetch,
) {
  const { rows: [intent] } = await pool.query<DeliveryProof & {
    status: string; endpoint: string; network: string; asset: string; payee: string; amount: string; refunded: boolean;
  }>(`
    SELECT i.id AS "intentId", i.status, i.endpoint, i.network, i.asset, i.payee, i.amount,
      j.payer, j.transaction_hash AS "transactionHash", r.intent_id IS NOT NULL AS refunded
    FROM payment_intents i JOIN research_tasks t ON t.id = i.task_id
    LEFT JOIN payment_journal j ON j.intent_id = i.id
    LEFT JOIN payment_refunds r ON r.intent_id = i.id
    WHERE i.id = $1 AND t.agent_id = $2
  `, [intentId, agentId]);
  if (!intent) throw new PaymentError(404, 'INTENT_NOT_FOUND');
  if (intent.refunded) throw new PaymentError(409, 'PAYMENT_REFUNDED');
  if (intent.status !== 'SETTLED' || !intent.transactionHash) throw new PaymentError(409, 'PAYMENT_NOT_SETTLED');
  if (intent.endpoint !== config.endpoint || intent.payee !== config.recipient ||
      intent.network !== marketNetwork || intent.asset !== baseSepoliaUsdc || intent.amount !== marketPrice) {
    throw new PaymentError(422, 'DELIVERY_SERVICE_NOT_SUPPORTED');
  }
  const { payer, transactionHash } = intent;
  const proof = { intentId, payer, transactionHash };
  try {
    const response = await fetcher(config.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      body: JSON.stringify(proof),
      headers: { 'content-type': 'application/json', 'delivery-signature': deliverySignature(config, proof) },
    });
    if (response.ok) return await response.json();
    await response.body?.cancel();
  } catch {
    throw new PaymentError(502, 'MERCHANT_DELIVERY_UNAVAILABLE');
  }
  throw new PaymentError(502, 'MERCHANT_DELIVERY_REJECTED');
}
