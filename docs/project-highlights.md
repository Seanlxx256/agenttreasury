# AgentTreasury — project highlights

A payments backend that lets internal AI agents buy API access with USDC through Circle
Gateway Nanopayments, and that treats payment-failure recovery and explainability as
first-class product concerns rather than afterthoughts.

## What's actually hard here

Anyone can add a budget or an allowlist. The hard part is the failure window: the buyer
sends a signed payment, the network drops, and now nobody is sure whether money moved.
AgentTreasury answers three questions under that uncertainty — *did we pay?*, *can we
recover the result without paying twice?*, and *can we prove the ledger is right to
finance?*

## Highlights

- **Official Circle SDK at the right layer.** Chain ID, USDC address, Gateway contract,
  and payer deposits come from `@circle-fin/x402-batching`, with an `GATEWAY_NETWORK=arc`
  switch for mainnet. The protocol is handwritten where the SDK's happy-path clients
  would hide the failure states this project governs — the boundary is in
  [sdk-adoption-boundary.md](sdk-adoption-boundary.md).
- **Buyer-side recovery.** A six-state machine covers submission-unknown →
  charged-delivery-missing → delivered, keyed by request ID and authorization nonce so a
  retry can never double-charge.
- **Dual-ledger reconciliation.** The local journal and Circle Gateway transfers are
  compared on both sides, and conflicts are surfaced for review instead of silently
  closed.
- **Dual-layer governance.** Fine-grained task budgets and payment-term allowlists in the
  application, backed by Circle Agent Wallet transfer limits and recipient policies as an
  unbroadcastable floor. Documented in
  [agent-wallet-governance-boundary.md](agent-wallet-governance-boundary.md).
- **Read-only triage agent with a swappable model.** A locally-run LLM picks an action
  and cites evidence, but the explanation is supplied by the server and the
  recommendation is advisory — the backend validates before acting. Models resolve
  through per-model prompt profiles, so a new model is a registry entry and the
  auditable JSON-schema envelope stays the same. The constraints are regression-tested.
- **Append-only audit and operator-gated refunds on both rails.** State transitions are
  recorded, refunds need a human decision, and the Gateway rail closes the loop for a
  charged-but-undelivered payment: approval, seller-initiated return, onchain evidence.

## Warts found and fixed

These are the parts a hiring manager should ask about, because they show the candidate
actually ran the thing:

1. Switching to the SDK's checksummed addresses exposed a **case-sensitive comparison
   bug** in quote validation. Fixed by comparing addresses case-insensitively.
2. The offline recovery drill reused a fixed transfer ID and hit a `UNIQUE` constraint on
   the second run. Fixed by deriving IDs from the request.
3. A weak local LLM generated explanations that contradicted its own action. Fixed by
   moving the explanation to the server and adding a regression test that feeds a
   contradictory stub response and asserts the displayed explanation comes from the
   server.

## Evidence it works

- Two real Arc testnet payments, including one lost-response recovery, with verified
  batch receipts.
- `npm test` passes 32/32.
- Triage evaluation is honest about model limits: the rule baseline scores near-perfect
  while a local Qwen2.5 0.5B scores well below it, so rules remain the default and the
  model is constrained, not trusted.

## Not done (and why)

- **Mainnet acceptance run.** Requires real mainnet USDC and Circle mainnet policies; the
  code path and config switch exist, but it has not been exercised with real funds.
- **Operator-time measurement.** The triage evaluation measures decision correctness and
  evidence, not the time saved in production.
