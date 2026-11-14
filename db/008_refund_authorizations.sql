CREATE TABLE refund_authorizations (
    intent_id uuid PRIMARY KEY REFERENCES payment_journal(intent_id),
    authorization_payload jsonb NOT NULL,
    transaction_hash text CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500)
);
