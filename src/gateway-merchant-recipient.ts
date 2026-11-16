import type { Pool } from 'pg';
import { recordAudit } from './audit.js';
import { transaction } from './db.js';
import { PaymentError } from './payments.js';

const merchantColumns = `id, recipient, endpoint_origin AS "endpointOrigin", network,
  recipient_change_version AS "recipientChangeVersion",
  pending_recipient AS "pendingRecipient",
  pending_recipient_version AS "pendingRecipientVersion",
  pending_recipient_requested_by AS "pendingRecipientRequestedBy",
  pending_recipient_requested_at AS "pendingRecipientRequestedAt"`;

const recipientPattern = /^0x[0-9a-f]{40}$/;

// Requesting a payout-address change does not move the live recipient. It stages
// the new address for review under a fresh, monotonically increasing version; the
// live address changes only on confirmation of that exact version.
export async function requestGatewayMerchantRecipientChange(
  pool: Pool, merchantId: string, newRecipient: string, requestedBy: string,
) {
  const recipient = newRecipient.toLowerCase();
  if (!recipientPattern.test(recipient)) throw new PaymentError(400, 'INVALID_RECIPIENT');
  return transaction(pool, async (client) => {
    const { rows: [merchant] } = await client.query<{ recipient: string; recipientChangeVersion: number }>(
      `SELECT recipient, recipient_change_version AS "recipientChangeVersion"
       FROM gateway_merchants WHERE id = $1 FOR UPDATE`, [merchantId],
    );
    if (!merchant) throw new PaymentError(404, 'MERCHANT_NOT_FOUND');
    if (recipient === merchant.recipient) throw new PaymentError(409, 'RECIPIENT_UNCHANGED');
    const pendingVersion = merchant.recipientChangeVersion + 1;
    const { rows: [updated] } = await client.query(
      `UPDATE gateway_merchants
       SET pending_recipient = $2, pending_recipient_requested_by = $3,
           pending_recipient_requested_at = now(), pending_recipient_version = $4
       WHERE id = $1 RETURNING ${merchantColumns}`,
      [merchantId, recipient, requestedBy, pendingVersion],
    );
    await recordAudit(client, {
      actor: requestedBy, action: 'gateway.merchant.recipient-change.requested',
      entity: `gateway_merchant:${merchantId}`, stateBefore: merchant.recipient, stateAfter: recipient,
    });
    return updated!;
  });
}

// A finance operator confirms a specific staged version. The operator names the
// address and version it reviewed; if a newer request has overwritten the pending
// address, the stale confirmation is rejected so the operator can never approve an
// address it did not actually see.
export async function confirmGatewayMerchantRecipientChange(
  pool: Pool, merchantId: string, version: number, expectedRecipient: string,
) {
  const expected = expectedRecipient.toLowerCase();
  return transaction(pool, async (client) => {
    const { rows: [merchant] } = await client.query<{
      recipient: string; pendingRecipient: string | null; pendingRecipientVersion: number | null;
    }>(
      `SELECT recipient, pending_recipient AS "pendingRecipient",
              pending_recipient_version AS "pendingRecipientVersion"
       FROM gateway_merchants WHERE id = $1 FOR UPDATE`, [merchantId],
    );
    if (!merchant) throw new PaymentError(404, 'MERCHANT_NOT_FOUND');
    if (!merchant.pendingRecipient) throw new PaymentError(409, 'NO_PENDING_RECIPIENT');
    if (merchant.pendingRecipient !== expected || merchant.pendingRecipientVersion !== version) {
      throw new PaymentError(409, 'RECIPIENT_CHANGE_STALE');
    }
    const { rows: [updated] } = await client.query(
      `UPDATE gateway_merchants
       SET recipient = pending_recipient, recipient_change_version = pending_recipient_version,
           pending_recipient = NULL, pending_recipient_requested_by = NULL,
           pending_recipient_requested_at = NULL, pending_recipient_version = NULL
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

// Re-authorize a task grant after the merchant payout address it was bound to
// changed. The operator names the address it reviewed (the merchant's current
// recipient); the grant's recipient moves only when they match, so a stale
// approval cannot point the grant at an address the operator did not see.
export async function reauthorizeGatewayGrantRecipient(
  pool: Pool, taskId: string, expectedRecipient: string, actor: string,
) {
  const expected = expectedRecipient.toLowerCase();
  if (!recipientPattern.test(expected)) throw new PaymentError(400, 'INVALID_RECIPIENT');
  return transaction(pool, async (client) => {
    const { rows: [grant] } = await client.query<{ merchantId: string | null; recipient: string }>(
      'SELECT merchant_id AS "merchantId", recipient FROM gateway_task_grants WHERE task_id = $1 FOR UPDATE',
      [taskId],
    );
    if (!grant) throw new PaymentError(404, 'GATEWAY_GRANT_NOT_FOUND');
    if (!grant.merchantId) throw new PaymentError(409, 'GRANT_NOT_MERCHANT_BOUND');
    const { rows: [merchant] } = await client.query<{ recipient: string }>(
      'SELECT recipient FROM gateway_merchants WHERE id = $1 FOR UPDATE', [grant.merchantId],
    );
    if (!merchant) throw new PaymentError(404, 'MERCHANT_NOT_FOUND');
    if (merchant.recipient !== expected) throw new PaymentError(409, 'RECIPIENT_CHANGE_STALE');
    if (grant.recipient === expected) throw new PaymentError(409, 'RECIPIENT_UNCHANGED');
    const { rows: [updated] } = await client.query(
      'UPDATE gateway_task_grants SET recipient = $2 WHERE task_id = $1 RETURNING recipient',
      [taskId, expected],
    );
    await recordAudit(client, {
      actor, action: 'gateway.grant.recipient-reauthorized',
      entity: `gateway_task_grant:${taskId}`, stateBefore: grant.recipient, stateAfter: expected,
    });
    return updated!;
  });
}
