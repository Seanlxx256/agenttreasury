CREATE TABLE payment_journal (
    intent_id uuid PRIMARY KEY REFERENCES payment_intents(id),
    network text NOT NULL,
    asset text NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
    payer text NOT NULL CHECK (payer ~ '^0x[0-9a-f]{40}$'),
    transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    amount bigint NOT NULL CHECK (amount > 0),
    settled_at timestamptz NOT NULL,
    posted_at timestamptz NOT NULL DEFAULT now()
);

-- A payment is one amount with two equal and opposite postings.
CREATE VIEW payment_journal_lines AS
SELECT j.intent_id, j.network, j.asset, j.payer, j.transaction_hash, j.settled_at, j.posted_at,
       line.number, line.account, line.side, j.amount
FROM payment_journal j
CROSS JOIN (VALUES
    (1, 'DATA_PROCUREMENT_EXPENSE', 'DEBIT'),
    (2, 'USDC_WALLET_ASSET', 'CREDIT')
) AS line(number, account, side);

INSERT INTO payment_journal (intent_id, network, asset, payer, transaction_hash, amount, settled_at)
SELECT id, network, asset, lower(signed_authorization->>'from'), lower(transaction_hash), amount, settled_at
FROM payment_intents WHERE status = 'SETTLED';
