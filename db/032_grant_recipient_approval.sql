-- Requests have their own monotonic sequence, including superseded proposals.
ALTER TABLE gateway_merchants
  ADD COLUMN recipient_request_version integer NOT NULL DEFAULT 0 CHECK (recipient_request_version >= 0);
UPDATE gateway_merchants
SET recipient_request_version = GREATEST(recipient_change_version, COALESCE(pending_recipient_version, 0));

ALTER TABLE gateway_task_grants
  ADD COLUMN approved_recipient_version integer CHECK (approved_recipient_version >= 0);

-- Only an unchanged merchant has an unambiguous historical approval. After any
-- address change, legacy grants need explicit finance reauthorization, even if
-- the address has since returned to its original value (A -> B -> A).
UPDATE gateway_task_grants g
SET approved_recipient_version = 0
FROM gateway_merchants m
WHERE g.merchant_id = m.id AND m.recipient_change_version = 0
  AND g.recipient = m.recipient AND g.network = m.network;
