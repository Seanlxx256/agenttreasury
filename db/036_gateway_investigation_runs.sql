-- Advisory evidence snapshots. No execution authority is stored here.
CREATE TABLE gateway_investigation_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES gateway_demo_purchases(request_id),
  actor text NOT NULL CHECK(actor IN ('operations','finance')),
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object')
);
CREATE INDEX gateway_investigation_runs_request_idx ON gateway_investigation_runs(request_id,id DESC);
