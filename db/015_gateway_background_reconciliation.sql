ALTER TABLE gateway_demo_purchases
  ADD COLUMN reconcile_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN reconcile_attempts integer NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
  ADD COLUMN reconcile_review_at timestamptz;

ALTER TABLE gateway_payment_observations
  DROP CONSTRAINT gateway_payment_observations_source_check,
  ADD CHECK (source IN ('buyer', 'finance', 'worker'));

CREATE INDEX gateway_reconciliation_due_idx ON gateway_demo_purchases (reconcile_after, request_id)
  WHERE budget_status = 'reserved' AND reconcile_review_at IS NULL;
