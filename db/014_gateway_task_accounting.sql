CREATE TABLE gateway_task_grants (
  task_id uuid PRIMARY KEY REFERENCES research_tasks(id),
  origin text NOT NULL,
  payer text NOT NULL CHECK (payer ~ '^0x[0-9a-f]{40}$'),
  recipient text NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$')
);

ALTER TABLE gateway_demo_purchases
  ADD COLUMN task_id uuid REFERENCES research_tasks(id),
  ADD COLUMN budget_day date,
  ADD COLUMN budget_status text CHECK (budget_status IN ('reserved', 'spent', 'released')),
  ADD COLUMN submitted_at timestamptz,
  ADD CHECK ((task_id IS NULL AND budget_day IS NULL AND budget_status IS NULL)
          OR (task_id IS NOT NULL AND budget_day IS NOT NULL AND budget_status IS NOT NULL));

CREATE TABLE gateway_payment_journal (
  request_id uuid PRIMARY KEY REFERENCES gateway_demo_purchases(request_id),
  transfer_id text NOT NULL UNIQUE,
  batch_hash text NOT NULL CHECK (batch_hash ~ '^0x[0-9a-f]{64}$'),
  amount bigint NOT NULL CHECK (amount > 0),
  posted_at timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW gateway_payment_journal_lines AS
SELECT j.request_id, j.transfer_id, j.batch_hash, j.posted_at, line.account, line.side, line.number, j.amount
FROM gateway_payment_journal j
CROSS JOIN (VALUES
  (1, 'DATA_PROCUREMENT_EXPENSE', 'DEBIT'),
  (2, 'USDC_GATEWAY_ASSET', 'CREDIT')
) AS line(number, account, side);
