-- Wallet-scoped event projections retain the original log and optional batch calldata.
CREATE TABLE gateway_balance_events (
  network text NOT NULL,
  payer text NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL CHECK (log_index >= 0),
  payload jsonb NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY (network, payer, transaction_hash, log_index)
);
CREATE TABLE gateway_balance_blocks (
  network text NOT NULL,
  block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL,
  PRIMARY KEY (network, block_number)
);
CREATE TABLE gateway_balance_evidence (
  scan_id uuid PRIMARY KEY REFERENCES gateway_balance_scans(id),
  version integer NOT NULL CHECK (version = 1),
  snapshot jsonb NOT NULL,
  digest text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION reject_balance_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Balance evidence is append-only';
END $$;
CREATE TRIGGER balance_events_immutable BEFORE UPDATE OR DELETE ON gateway_balance_events
  FOR EACH ROW EXECUTE FUNCTION reject_balance_evidence_mutation();
CREATE TRIGGER balance_blocks_immutable BEFORE UPDATE OR DELETE ON gateway_balance_blocks
  FOR EACH ROW EXECUTE FUNCTION reject_balance_evidence_mutation();
CREATE TRIGGER balance_evidence_immutable BEFORE UPDATE OR DELETE ON gateway_balance_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_balance_evidence_mutation();
