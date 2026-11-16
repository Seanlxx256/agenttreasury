-- Recipient change review.
--
-- A merchant's payout address is the highest-value target of B2B push-payment
-- fraud ("change the bank account"), so it never changes silently. Changing it
-- is a two-step human-reviewed operation: request a new address, then confirm it.
-- The live recipient moves only when a finance operator confirms.
ALTER TABLE gateway_merchants
  ADD COLUMN pending_recipient text,
  ADD COLUMN pending_recipient_requested_by text,
  ADD COLUMN pending_recipient_requested_at timestamptz,
  ADD CHECK (pending_recipient IS NULL OR pending_recipient ~ '^0x[0-9a-f]{40}$');
