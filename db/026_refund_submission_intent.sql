-- Close the broadcast-then-persist window in the gateway refund command.
--
-- The refund transaction hash used to be written only after broadcast, so a crash
-- between broadcast and persist would re-transfer USDC on retry. A "submitting"
-- row is now persisted BEFORE broadcast; a retry therefore always sees prior
-- state and never re-broadcasts, while an unresolved "submitting" row forces
-- onchain verification instead of an automatic second transfer.
ALTER TABLE gateway_refund_authorizations
  ADD COLUMN status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitting', 'submitted')),
  ALTER COLUMN transaction_hash DROP NOT NULL,
  ADD CHECK ((status = 'submitting' AND transaction_hash IS NULL) OR
             (status = 'submitted' AND transaction_hash IS NOT NULL));
