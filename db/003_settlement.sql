ALTER TABLE payment_intents DROP CONSTRAINT payment_status, DROP CONSTRAINT payment_reason, DROP CONSTRAINT payment_quote;
ALTER TABLE payment_intents
    ADD COLUMN signed_authorization jsonb,
    ADD COLUMN transaction_hash text CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
    ADD COLUMN settled_at timestamptz,
    ADD CONSTRAINT payment_status CHECK (status IN (
      'RESERVED', 'QUOTED', 'REJECTED', 'FAILED', 'AUTHORIZED', 'SUBMITTED', 'UNKNOWN', 'SETTLED'
    )),
    ADD CONSTRAINT payment_reason CHECK ((reason IS NOT NULL) = (status IN ('REJECTED', 'FAILED'))),
    ADD CONSTRAINT payment_quote CHECK (
      status NOT IN ('QUOTED', 'AUTHORIZED', 'SUBMITTED', 'UNKNOWN', 'SETTLED') OR quote IS NOT NULL
    ),
    ADD CONSTRAINT payment_authorization CHECK (
      status NOT IN ('AUTHORIZED', 'SUBMITTED', 'UNKNOWN', 'SETTLED') OR signed_authorization IS NOT NULL
    ),
    ADD CONSTRAINT payment_settlement CHECK (
      (settled_at IS NOT NULL) = (status = 'SETTLED') AND
      (status NOT IN ('SUBMITTED', 'SETTLED') OR transaction_hash IS NOT NULL)
    );

CREATE UNIQUE INDEX payment_authorization_nonce ON payment_intents ((signed_authorization->>'nonce'))
    WHERE signed_authorization IS NOT NULL;
CREATE INDEX outbox_settlement_pending ON outbox (available_at, id)
    WHERE processed_at IS NULL AND event_type = 'payment.quoted';
