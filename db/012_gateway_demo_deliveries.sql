ALTER TABLE gateway_demo_purchases ADD COLUMN retrieval_token text;

CREATE TABLE gateway_demo_deliveries (
  request_id uuid PRIMARY KEY,
  nonce text NOT NULL UNIQUE,
  token_digest text NOT NULL,
  delivery jsonb
);
