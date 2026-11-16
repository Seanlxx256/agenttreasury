-- A case groups repeated sightings; discrepancy rows remain original evidence.
CREATE FUNCTION gateway_case_subject(kind text, detail jsonb, from_block bigint, to_block bigint, fallback uuid)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN kind = 'unresolved-authorization' THEN coalesce(nullif(detail->>'requestId', ''), 'legacy:' || fallback::text)
    WHEN kind IN ('batch', 'missing-batch') THEN coalesce(nullif(lower(detail->>'hash'), ''), 'legacy:' || fallback::text)
    ELSE from_block::text || ':' || to_block::text END
$$;

CREATE TABLE gateway_reconciliation_cases (
  id uuid PRIMARY KEY,
  network text NOT NULL,
  payer text NOT NULL,
  kind text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  latest_discrepancy_id uuid NOT NULL REFERENCES gateway_balance_discrepancies(id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (network, payer, kind, subject)
);
ALTER TABLE gateway_balance_discrepancies ADD COLUMN case_id uuid REFERENCES gateway_reconciliation_cases(id);
CREATE INDEX gateway_discrepancies_case_idx ON gateway_balance_discrepancies(case_id);
CREATE INDEX gateway_cases_status_idx ON gateway_reconciliation_cases(status, first_seen_at);

CREATE TABLE gateway_case_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES gateway_reconciliation_cases(id),
  version integer NOT NULL,
  actor text NOT NULL,
  event text NOT NULL,
  status text NOT NULL,
  note text NOT NULL,
  evidence_id uuid NOT NULL REFERENCES gateway_balance_discrepancies(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(case_id, version)
);

-- Replay legacy sightings in order. Unresolved evidence wins over historical
-- closure, rather than silently losing an operator's outstanding work.
DO $$
DECLARE d record; cid uuid;
BEGIN
  FOR d IN SELECT source.*, s.network, s.payer, s.from_block, s.to_block
    FROM gateway_balance_discrepancies source JOIN gateway_balance_scans s ON s.id = source.scan_id
    ORDER BY source.created_at, source.id
  LOOP
    INSERT INTO gateway_reconciliation_cases(id, network, payer, kind, subject, status,
      latest_discrepancy_id, first_seen_at, last_seen_at, resolved_at)
    VALUES(d.id, d.network, d.payer, d.kind,
      gateway_case_subject(d.kind, d.detail, d.from_block, d.to_block, d.id),
      CASE d.status WHEN 'acknowledged' THEN 'investigating' ELSE d.status END,
      d.id, d.created_at, d.created_at, d.resolved_at)
    ON CONFLICT(network, payer, kind, subject) DO UPDATE SET
      version = gateway_reconciliation_cases.version + 1,
      latest_discrepancy_id = excluded.latest_discrepancy_id,
      last_seen_at = excluded.last_seen_at,
      status = CASE WHEN gateway_reconciliation_cases.status = 'resolved' AND excluded.status = 'resolved'
        THEN 'resolved' ELSE 'open' END,
      resolved_at = CASE WHEN gateway_reconciliation_cases.status = 'resolved' AND excluded.status = 'resolved'
        THEN excluded.resolved_at ELSE NULL END
    RETURNING id INTO cid;
    UPDATE gateway_balance_discrepancies SET case_id = cid WHERE id = d.id;
    INSERT INTO gateway_case_events(case_id, version, actor, event, status, note, evidence_id)
      SELECT cid, version, 'migration:034', 'imported', status, 'Legacy scan evidence imported; original status retained on evidence.', d.id
      FROM gateway_reconciliation_cases WHERE id = cid;
  END LOOP;
END $$;

CREATE TABLE gateway_balance_heads (
  network text NOT NULL,
  payer text NOT NULL,
  finalized_block bigint NOT NULL CHECK (finalized_block >= 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network, payer)
);

CREATE TABLE gateway_worker_health (
  worker text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  failure_count bigint NOT NULL DEFAULT 0
);
