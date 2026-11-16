-- A purchase and its task grant now carry the Gateway network they run on,
-- instead of inheriting one process-wide network from the environment. This is
-- what lets a single worker/reconciliation pass span testnet and mainnet (and,
-- later, other Gateway chains) without restarting per network.
ALTER TABLE gateway_demo_purchases
  ADD COLUMN network text NOT NULL DEFAULT 'arcTestnet'
  CHECK (network IN ('arc', 'arcTestnet'));

ALTER TABLE gateway_task_grants
  ADD COLUMN network text NOT NULL DEFAULT 'arcTestnet'
  CHECK (network IN ('arc', 'arcTestnet'));
