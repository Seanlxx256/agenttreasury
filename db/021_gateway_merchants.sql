-- A merchant is now a first-class entity (recipient + endpoint + network)
-- instead of a single process-wide recipient. This lets one deployment settle
-- for several merchants, each pinned to its own network and payout address.
CREATE TABLE gateway_merchants (
  id uuid PRIMARY KEY,
  recipient text NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  endpoint_origin text NOT NULL,
  network text NOT NULL DEFAULT 'arcTestnet' CHECK (network IN ('arc', 'arcTestnet')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient, network)
);

ALTER TABLE gateway_demo_purchases
  ADD COLUMN merchant_id uuid REFERENCES gateway_merchants(id);

ALTER TABLE gateway_task_grants
  ADD COLUMN merchant_id uuid REFERENCES gateway_merchants(id);
