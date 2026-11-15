CREATE TABLE gateway_demo_purchases (
  request_id uuid PRIMARY KEY,
  endpoint text NOT NULL,
  nonce text NOT NULL UNIQUE,
  payer text NOT NULL,
  recipient text NOT NULL,
  amount_units bigint NOT NULL CHECK (amount_units > 0),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  delivery jsonb
);
