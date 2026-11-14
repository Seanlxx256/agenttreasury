ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_status_check;
ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_check;
ALTER TABLE payment_intents
    ADD CONSTRAINT payment_status CHECK (status IN ('RESERVED', 'QUOTED', 'REJECTED', 'FAILED')),
    ADD CONSTRAINT payment_reason CHECK ((reason IS NULL) = (status IN ('RESERVED', 'QUOTED'))),
    ADD COLUMN quote jsonb,
    ADD CONSTRAINT payment_quote CHECK ((quote IS NOT NULL) = (status = 'QUOTED'));

ALTER TABLE outbox
    ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN lease_token uuid,
    ADD COLUMN attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN processed_at timestamptz;

CREATE INDEX outbox_pending ON outbox (available_at, id)
    WHERE processed_at IS NULL AND event_type = 'payment.reserved';
