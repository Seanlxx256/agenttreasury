import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from './db.js';
import { PaymentError } from './payments.js';

export async function executeDemoDecision(pool: Pool, intentId: string, action: 'refund' | 'deliver') {
  return transaction(pool, async (client) => {
    const payment = await client.query(
      "SELECT 1 FROM payment_journal WHERE intent_id = $1 AND network = 'demo:local' FOR UPDATE", [intentId],
    );
    if (payment.rowCount !== 1) throw new PaymentError(404, 'DEMO_PAYMENT_NOT_FOUND');
    const { rows: [order] } = await client.query(`
      SELECT q.status, q.reason, j.transaction_hash,
        r.intent_id IS NOT NULL AS refunded, d.intent_id IS NOT NULL AS delivered
      FROM payment_journal j
      LEFT JOIN refund_requests q ON q.intent_id = j.intent_id
      LEFT JOIN payment_refunds r ON r.intent_id = j.intent_id
      LEFT JOIN merchant_deliveries d ON d.intent_id = j.intent_id
      WHERE j.intent_id = $1
    `, [intentId]);

    if (action === 'refund') {
      if (order.status !== 'APPROVED' || order.delivered) throw new PaymentError(409, 'DEMO_REFUND_NOT_ALLOWED');
      if (!order.refunded) {
        // The shared ledger requires transfer identifiers. These identify local fixtures only.
        await client.query(`
          INSERT INTO payment_refunds (intent_id, network, transaction_hash, log_index, block_number, block_hash, reason)
          VALUES ($1, 'demo:local', $2, 0, 0, $3, $4)
        `, [intentId, '0x' + randomBytes(32).toString('hex'), '0x' + '0'.repeat(64), order.reason]);
      }
      return { status: 'REFUNDED' };
    }

    if (order.status !== 'DENIED' || order.refunded) throw new PaymentError(409, 'DEMO_DELIVERY_NOT_ALLOWED');
    if (!order.delivered) {
      await client.query(`
        INSERT INTO merchant_deliveries (intent_id, transaction_hash, result)
        VALUES ($1, $2, $3)
      `, [intentId, order.transaction_hash, { market: 'DE', category: 'camping lanterns', sample: true }]);
    }
    return { status: 'DELIVERED' };
  });
}
