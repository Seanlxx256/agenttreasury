CREATE TABLE refund_requests (
    intent_id uuid PRIMARY KEY REFERENCES payment_journal(intent_id),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'DENIED')),
    requested_by uuid NOT NULL REFERENCES agents(id),
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_by text,
    decided_at timestamptz,
    CHECK ((decided_by IS NULL AND decided_at IS NULL AND status = 'PENDING') OR
           (decided_by IS NOT NULL AND decided_at IS NOT NULL AND status <> 'PENDING'))
);
