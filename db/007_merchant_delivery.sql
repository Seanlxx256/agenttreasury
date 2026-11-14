ALTER TABLE services DROP CONSTRAINT services_endpoint_check;
ALTER TABLE services ADD CONSTRAINT services_endpoint_check CHECK (
    endpoint LIKE 'https://%' OR endpoint ~ '^http://127\.0\.0\.1:[0-9]+/market-data$'
);

CREATE TABLE merchant_deliveries (
    intent_id uuid PRIMARY KEY,
    transaction_hash text NOT NULL UNIQUE CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    result jsonb NOT NULL,
    delivered_at timestamptz NOT NULL DEFAULT now()
);
