-- A REFUND arbitration approves the refund but does not move money yet. The
-- onchain transfer runs through the refund broadcast entry point and is only
-- confirmed through the evidence path, so "approved" and "refunded" must be two
-- distinct dispute states. Keeping them apart stops the console from claiming a
-- refund exists before the transfer has been proven onchain.
ALTER TABLE gateway_delivery_disputes DROP CONSTRAINT gateway_delivery_disputes_status_check;
ALTER TABLE gateway_delivery_disputes ADD CONSTRAINT gateway_delivery_disputes_status_check
  CHECK (status IN ('OPEN', 'REFUND_APPROVED', 'REFUNDED', 'DISMISSED'));
