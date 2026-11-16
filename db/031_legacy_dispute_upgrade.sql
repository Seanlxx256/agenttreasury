-- Upgrade legacy dispute rows to the approve-then-refund semantics.
--
-- Before the REFUND_APPROVED state existed, a dispute approval wrote REFUNDED
-- immediately, even though no onchain refund had been proven yet. New code
-- treats REFUNDED as "refund evidence posted" and requires REFUND_APPROVED for
-- the broadcast entry point. Historical rows therefore split by evidence:
-- an approval with no recorded refund becomes REFUND_APPROVED (refundable
-- again), while an approval whose refund is already posted stays REFUNDED.
UPDATE gateway_delivery_disputes d
SET status = 'REFUND_APPROVED'
WHERE d.status = 'REFUNDED'
  AND NOT EXISTS (SELECT 1 FROM gateway_payment_refunds r WHERE r.request_id = d.request_id);
