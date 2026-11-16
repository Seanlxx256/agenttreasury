CREATE TABLE gateway_balance_cursors (
  network text NOT NULL,
  payer text NOT NULL,
  next_block bigint NOT NULL CHECK (next_block >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, payer)
);

CREATE TABLE gateway_balance_scans (
  id uuid PRIMARY KEY,
  network text NOT NULL,
  payer text NOT NULL,
  from_block bigint NOT NULL CHECK (from_block >= 1),
  to_block bigint NOT NULL CHECK (to_block >= from_block),
  status text NOT NULL CHECK (status IN ('running', 'matched', 'discrepancy', 'failed')),
  result jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (network, payer, from_block, to_block)
);

CREATE INDEX gateway_balance_scans_status_idx ON gateway_balance_scans (status, lease_until);

CREATE TABLE gateway_balance_discrepancies (
  id uuid PRIMARY KEY,
  scan_id uuid NOT NULL REFERENCES gateway_balance_scans(id),
  kind text NOT NULL CHECK (kind IN ('balance', 'batch', 'missing-batch', 'unresolved-authorization')),
  detail jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (scan_id, kind, detail)
);

CREATE INDEX gateway_balance_discrepancies_open_idx ON gateway_balance_discrepancies (status)
  WHERE status = 'open';
