-- Legacy purchases lack an exact validity window and cannot be newly signed.
ALTER TABLE gateway_demo_purchases
  ADD COLUMN signing_authorization jsonb,
  ADD COLUMN signing_started_at timestamptz;

CREATE TABLE gateway_signatures (
  request_id uuid PRIMARY KEY REFERENCES gateway_demo_purchases(request_id),
  authorization_hash text NOT NULL CHECK (authorization_hash ~ '^0x[0-9a-f]{64}$'),
  signature text CHECK (signature ~ '^0x[0-9a-fA-F]{130}$'),
  issued_at timestamptz,
  CHECK ((signature IS NULL) = (issued_at IS NULL))
);

-- Once issuance may have happened, the authorization and its accounting owner
-- must never be changed or deleted by normal application writes.
CREATE FUNCTION guard_gateway_signing_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signing_started_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete a purchase after signing began';
    END IF;
    IF ROW(NEW.signing_authorization, NEW.signing_started_at, NEW.request_id, NEW.nonce, NEW.payer,
      NEW.recipient, NEW.amount_units, NEW.network, NEW.endpoint, NEW.task_id, NEW.budget_day)
      IS DISTINCT FROM ROW(OLD.signing_authorization, OLD.signing_started_at, OLD.request_id, OLD.nonce, OLD.payer,
      OLD.recipient, OLD.amount_units, OLD.network, OLD.endpoint, OLD.task_id, OLD.budget_day) THEN
      RAISE EXCEPTION 'Cannot change purchase terms after signing began';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gateway_signing_terms_guard BEFORE UPDATE OR DELETE ON gateway_demo_purchases
  FOR EACH ROW EXECUTE FUNCTION guard_gateway_signing_terms();
