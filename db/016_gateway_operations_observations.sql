ALTER TABLE gateway_payment_observations
  DROP CONSTRAINT gateway_payment_observations_source_check,
  ADD CHECK (source IN ('buyer', 'finance', 'operations', 'worker'));
