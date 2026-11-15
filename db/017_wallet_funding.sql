CREATE TABLE wallet_funding (
    network text NOT NULL,
    asset text NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
    payer text NOT NULL CHECK (payer ~ '^0x[0-9a-f]{40}$'),
    sender text NOT NULL CHECK (sender ~ '^0x[0-9a-f]{40}$' AND sender <> payer),
    transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    log_index integer NOT NULL CHECK (log_index >= 0),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    amount bigint NOT NULL CHECK (amount > 0),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    posted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (network, transaction_hash, log_index)
);

CREATE INDEX wallet_funding_range ON wallet_funding (network, asset, payer, block_number);

CREATE VIEW funding_journal_lines AS
SELECT f.*, line.number, line.account, line.side
FROM wallet_funding f
CROSS JOIN (VALUES (1, 'USDC_WALLET_ASSET', 'DEBIT'), (2, 'USDC_FUNDING_SOURCE', 'CREDIT'))
    AS line(number, account, side);
