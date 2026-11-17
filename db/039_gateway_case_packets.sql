-- Advisory operator material only; never a payment or refund authorization.
CREATE TABLE gateway_case_packets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES gateway_demo_purchases(request_id),
  actor text NOT NULL CHECK(actor IN ('operations','finance')),
  created_at timestamptz NOT NULL DEFAULT now(),
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object')
);
CREATE INDEX gateway_case_packets_request_idx ON gateway_case_packets(request_id,id DESC);
CREATE FUNCTION prevent_case_packet_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Case packets are append-only'; END;
$$;
CREATE TRIGGER immutable_case_packets BEFORE UPDATE OR DELETE ON gateway_case_packets
FOR EACH ROW EXECUTE FUNCTION prevent_case_packet_mutation();
