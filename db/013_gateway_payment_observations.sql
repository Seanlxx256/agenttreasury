CREATE TABLE gateway_payment_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES gateway_demo_purchases(request_id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('buyer', 'finance')),
  evidence jsonb NOT NULL
);

CREATE INDEX gateway_payment_observations_request_idx
  ON gateway_payment_observations (request_id, id DESC);
