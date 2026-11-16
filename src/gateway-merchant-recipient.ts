import type { Pool } from 'pg';
import { recordAudit } from './audit.js';
import { transaction } from './db.js';
import { PaymentError } from './payments.js';

const merchantColumns = `id, recipient, endpoint_origin AS "endpointOrigin", network,
  pending_recipient AS "pendingRecipient",
  pending_recipient_requested_by AS "pendingRecipientRequestedBy",
  pending_recipient_requested_at AS "pendingRecipientRequestedAt"`;

const recipientPattern = /^0x[0-9a-f]{40}$/;

// Requesting a payout-address change does not move the live recipient. It stages
// the new address for review; the live address changes only on confirmation.
export async function requestGatewayMerchantRecipientChange(
  pool: Pool, merchantId: string, newRecipient: string, requestedBy: string,
) {
  const recipient = newRecipient.toLowerCase();
  if (!recipientPattern.test(recipient)) throw new PaymentError(400, 'INVALID_RECIPIENT');
  return transaction(pool, async (client) => {
    const { rows: [merchant] } = await client.query<{ recipient: string }>(
      'SELECT recipient FROM gateway_merchants WHERE id = $1 FOR UPDATE', [merchantId],
    );
    if (!merchant) throw new PaymentError(404, 'MERCHANT_NOT_FOUND');
    if (recipient === merchant.recipient) throw new PaymentError(409, 'RECIPIENT_UNCHANGED');
    const { rows: [updated] } = await client.query(
      `UPDATE gateway_merchants
       SET pending_recipient = $2, pending_recipient_requested_by = $3, pending_recipient_requested_at = now()
       WHERE id = $1 RETURNING ${merchantColumns}`,
      [merchantId, recipient, requestedBy],
    );
    await recordAudit(client, {
      actor: requestedBy, action: 'gateway.merchant.recipient-change.requested',
      entity: `gateway_merchant:${merchantId}`, stateBefore: merchant.recipient, stateAfter: recipient,
    });
    return updated!;
  });
}

// A finance operator confirms the staged address, which is the only point where
// the live recipient actually moves.
export async function confirmGatewayMerchantRecipientChange(pool: Pool, merchantId: string) {
  return transaction(pool, async (client) => {
    const { rows: [merchant] } = await client.query<{ recipient: string; pendingRecipient: string | null }>(
      'SELECT recipient, pending_recipient AS "pendingRecipient" FROM gateway_merchants WHERE id = $1 FOR UPDATE',
      [merchantId],
    );
    if (!merchant) throw new PaymentError(404, 'MERCHANT_NOT_FOUND');
    if (!merchant.pendingRecipient) throw new PaymentError(409, 'NO_PENDING_RECIPIENT');
    const { rows: [updated] } = await client.query(
      `UPDATE gateway_merchants
       SET recipient = pending_recipient, pending_recipient = NULL,
           pending_recipient_requested_by = NULL, pending_recipient_requested_at = NULL
       WHERE id = $1 RETURNING ${merchantColumns}`,
      [merchantId],
    );
    await recordAudit(client, {
      actor: 'finance-operator', action: 'gateway.merchant.recipient-change.confirmed',
      entity: `gateway_merchant:${merchantId}`, stateBefore: merchant.recipient, stateAfter: merchant.pendingRecipient,
    });
    return updated!;
  });
}
