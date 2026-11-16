-- A delivery dispute covers the failure mode the refund request does not:
-- the payment is charged AND a delivery exists, but the buyer asserts the
-- delivery content is wrong. x402 is pay-then-verify with no chargeback
-- primitive, so the dispute is a human-arbitrated state machine that either
-- authorizes a refund (executed through the existing refund evidence path) or
-- dismisses the claim. The buyer's assertion is stored as structured evidence
-- so the audit trail keeps the "expected vs received" story intact.
CREATE TABLE gateway_delivery_disputes (
    request_id uuid PRIMARY KEY REFERENCES gateway_payment_journal(request_id),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    evidence jsonb NOT NULL,
    status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REFUNDED', 'DISMISSED')),
    raised_by uuid NOT NULL REFERENCES agents(id),
    raised_at timestamptz NOT NULL DEFAULT now(),
    decided_by text,
    decided_at timestamptz,
    CHECK ((decided_by IS NULL AND decided_at IS NULL AND status = 'OPEN') OR
           (decided_by IS NOT NULL AND decided_at IS NOT NULL AND status <> 'OPEN'))
);
