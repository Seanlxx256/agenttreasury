-- Only advisory investigation state; no payment authorization or signing data.
CREATE TABLE gateway_investigation_checkpoints (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES gateway_demo_purchases(request_id),
  protocol integer NOT NULL DEFAULT 1 CHECK (protocol = 1),
  actor text NOT NULL CHECK (actor IN ('operations','finance')),
  last_actor text NOT NULL CHECK (last_actor IN ('operations','finance')),
  model text,
  refresh_external boolean NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  progress jsonb NOT NULL CHECK (jsonb_typeof(progress) = 'object'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status text NOT NULL DEFAULT 'in-progress' CHECK (status IN ('in-progress','finished')),
  run_id bigint UNIQUE REFERENCES gateway_investigation_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'finished') = (run_id IS NOT NULL))
);
CREATE INDEX gateway_investigation_checkpoints_request_idx
  ON gateway_investigation_checkpoints(request_id, created_at DESC, id DESC);
