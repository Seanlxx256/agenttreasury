CREATE INDEX payment_journal_wallet ON payment_journal (network, asset, payer);

CREATE TABLE reconciliation_runs (
    network text NOT NULL,
    asset text NOT NULL,
    payer text NOT NULL,
    from_block bigint NOT NULL CHECK (from_block >= 0),
    to_block bigint NOT NULL CHECK (to_block >= from_block),
    to_block_hash text NOT NULL,
    report jsonb NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (network, asset, payer, from_block, to_block)
);
