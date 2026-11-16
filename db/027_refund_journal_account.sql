-- Fix the refund journal's asset account.
--
-- A gateway refund is a plain USDC transfer from the merchant's EOA back to the
-- payer's address, so it restores a normal-wallet balance — not a Gateway
-- deposit balance. The previous view debited USDC_GATEWAY_ASSET, which is a
-- different asset location.
CREATE OR REPLACE VIEW gateway_refund_journal_lines AS
SELECT r.request_id, r.transaction_hash, r.log_index, r.posted_at,
       line.number, line.account, line.side, j.amount
FROM gateway_payment_refunds r
JOIN gateway_payment_journal j ON j.request_id = r.request_id
CROSS JOIN (VALUES
    (1, 'USDC_WALLET_ASSET', 'DEBIT'),
    (2, 'DATA_PROCUREMENT_EXPENSE', 'CREDIT')
) AS line(number, account, side);
