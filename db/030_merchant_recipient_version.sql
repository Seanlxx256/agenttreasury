-- Bind recipient approval to the exact address version finance reviewed.
--
-- A merchant payout-address change is staged with a monotonically increasing
-- version number. Finance confirms by naming the version and address it actually
-- reviewed; if a second request has overwritten the pending address in the
-- meantime, the stale confirmation is rejected instead of silently approving
-- the newer address. The version also lets the payment path detect that a task
-- grant predates a recipient change and must be re-authorized.
ALTER TABLE gateway_merchants
  ADD COLUMN recipient_change_version integer NOT NULL DEFAULT 0,
  ADD COLUMN pending_recipient_version integer,
  ADD CHECK (pending_recipient IS NULL OR pending_recipient_version IS NOT NULL),
  ADD CHECK (pending_recipient_version IS NULL OR pending_recipient_version > 0);
