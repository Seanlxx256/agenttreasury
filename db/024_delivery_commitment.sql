-- Delivery commitment binding.
--
-- The merchant's offer declares what a valid delivery must look like, the buyer
-- stores that commitment at purchase time, and checking the received delivery
-- against it produces an objective assessment. The dispute path snapshots that
-- assessment next to the buyer's claim, so arbitration sees the reproducible
-- "expected vs received" mismatch instead of only the buyer's assertion.
ALTER TABLE gateway_demo_purchases
  ADD COLUMN delivery_commitment jsonb,
  ADD COLUMN commitment_satisfied boolean,
  ADD COLUMN commitment_violations jsonb;

ALTER TABLE gateway_delivery_disputes
  ADD COLUMN delivery_assessment jsonb;
