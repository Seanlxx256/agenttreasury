-- Preserve the recorded facts and unverified interpretations separately.
-- A saved review is advisory; it never authorizes payment or closes a case.
CREATE TABLE gateway_triage_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES gateway_demo_purchases(request_id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (actor IN ('finance', 'operations')),
  model text,
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'array'),
  inferences jsonb NOT NULL CHECK (jsonb_typeof(inferences) = 'array'),
  rules jsonb NOT NULL,
  agent jsonb NOT NULL
);
CREATE INDEX gateway_triage_reviews_request_idx ON gateway_triage_reviews (request_id, id DESC);
