-- Index only the purchase bindings, not bulky raw event logs/calldata.
CREATE INDEX gateway_balance_evidence_purchase_lookup
  ON gateway_balance_evidence USING gin ((snapshot->'purchases') jsonb_path_ops);
