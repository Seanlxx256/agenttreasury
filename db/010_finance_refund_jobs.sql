CREATE TABLE finance_refund_jobs (
    intent_id uuid PRIMARY KEY REFERENCES refund_requests(intent_id),
    reason text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    finished_at timestamptz,
    last_error text
);
