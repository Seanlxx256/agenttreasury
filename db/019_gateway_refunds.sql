CREATE TABLE gateway_refund_requests (
    request_id uuid PRIMARY KEY REFERENCES gateway_payment_journal(request_id),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'DENIED')),
    requested_by uuid NOT NULL REFERENCES agents(id),
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_by text,
    decided_at timestamptz,
    CHECK ((decided_by IS NULL AND decided_at IS NULL AND status = 'PENDING') OR
           (decided_by IS NOT NULL AND decided_at IS NOT NULL AND status <> 'PENDING'))
);

CREATE TABLE gateway_refund_authorizations (
    request_id uuid PRIMARY KEY REFERENCES gateway_payment_journal(request_id),
    transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gateway_payment_refunds (
    request_id uuid PRIMARY KEY REFERENCES gateway_payment_journal(request_id),
    network text NOT NULL,
    transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    log_index integer NOT NULL CHECK (log_index >= 0),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    posted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (network, transaction_hash, log_index)
);

CREATE VIEW gateway_refund_journal_lines AS
SELECT r.request_id, r.transaction_hash, r.log_index, r.posted_at,
       line.number, line.account, line.side, j.amount
FROM gateway_payment_refunds r
JOIN gateway_payment_journal j ON j.request_id = r.request_id
CROSS JOIN (VALUES
    (1, 'USDC_GATEWAY_ASSET', 'DEBIT'),
    (2, 'DATA_PROCUREMENT_EXPENSE', 'CREDIT')
) AS line(number, account, side);
