CREATE TABLE payment_refunds (
    intent_id uuid PRIMARY KEY REFERENCES payment_journal(intent_id),
    network text NOT NULL,
    transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    log_index integer NOT NULL CHECK (log_index >= 0),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    posted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (network, transaction_hash, log_index)
);

CREATE VIEW refund_journal_lines AS
SELECT r.intent_id, r.transaction_hash, r.log_index, r.posted_at, j.asset,
       line.number, line.account, line.side, j.amount
FROM payment_refunds r
JOIN payment_journal j ON j.intent_id = r.intent_id
CROSS JOIN (VALUES
    (1, 'USDC_WALLET_ASSET', 'DEBIT'),
    (2, 'DATA_PROCUREMENT_EXPENSE', 'CREDIT')
) AS line(number, account, side);
