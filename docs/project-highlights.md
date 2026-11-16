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
  retry replays idempotently instead of double-charging.
- **Dual-ledger reconciliation.** The local journal and Circle Gateway transfers are
  compared on both sides, and conflicts are surfaced for review instead of silently
  closed.
- **Application-layer spend governance.** Fine-grained task budgets and payment-term
  allowlists in the application, plus operator-gated refunds. Circle Agent Wallet transfer
  limits and recipient policies are documented as a deployment recommendation for mainnet
  wallets only — enforcement is not verified here, because the self-custodied EOA that
  signs Gateway batch settlement is not proven to pass through the wallet's policy layer.
  Documented in [agent-wallet-governance-boundary.md](agent-wallet-governance-boundary.md).
- **Read-only triage agent with a swappable model.** A locally-run LLM picks an action
  and cites evidence, but the explanation is supplied by the server and the
  recommendation is advisory — the backend validates before acting. Models resolve
  through per-model prompt profiles, so a new model is a registry entry and the
  auditable JSON-schema envelope stays the same. The constraints are regression-tested.
- **Append-only audit and operator-gated refunds on both rails.** State transitions are
  recorded, refunds need a human decision, and the Gateway rail closes the loop for a
  charged-but-undelivered payment: approval, seller-initiated return, onchain evidence.
  The onchain return is at-most-once by construction, not exactly-once: a submission intent
  is persisted before broadcasting, and an unresolved broadcast is never re-sent
  automatically — an operator verifies the transfer and resumes.
- **Tamper-evident audit chain (within its limits).** Every audit row hashes its own fields
  plus the previous row's hash, so editing a row or reordering the log breaks the chain and
  is detectable offline without trusting the database operator — the application-layer answer
  to x402's missing self-contained receipt. `verifyAuditChain()` recomputes the chain end to
  end, and concurrent writers are serialized by an advisory lock so the chain can never fork.
  The chain has no external anchor, so it cannot detect a truncated tail, a fully rewritten
  chain, or the removal of all hashes; those still trust the database operator.
- **Delivery disputes for pay-then-verify.** A charged payment with a delivered-but-wrong
  result can be raised as a dispute, kept separate from the missing-delivery refund path,
  and arbitrated by an operator into a refund — executed through the same onchain evidence
  rules — or a dismissal. The buyer's expected-vs-received claim stays in the audit trail.
- **Delivery commitment binding.** The merchant's offer declares what a valid delivery must
  look like, the buyer stores that commitment at purchase time and checks the received
  delivery against it, and the dispute path snapshots the objective mismatch next to the
  buyer's claim. "Expected vs received" becomes reproducible evidence instead of a
  pay-then-verify assertion.
- **Commitment-aware triage and recipient-change review.** The read-only triage agent
  recognizes a delivered-but-commitment-violating payment and recommends raising a dispute,
  and a merchant payout address can never change silently — it is staged and then confirmed
  by a finance operator, closing the "change the bank account" B2B fraud vector.
- **Multi-network, multi-merchant, multi-process.** The network is a column on each
  purchase, resolved through a per-network config factory derived from Circle's official
  SDK, so one worker pool spans testnet and mainnet. Merchants are first-class entities
  keyed on `(recipient, network)`. Concurrent workers claim work with `SKIP LOCKED` plus
  a lease, so several processes can settle the same due queue without double-claiming work. Documented in
  [distributed-multi-network.md](distributed-multi-network.md).
- **A failure catalog, not just scattered fixes.** Every failure mode — lost response,
  double charge, reorg, reverted batch, wrong refund, contradictory transfer evidence,
  paid-but-wrong delivery — has a detection path, a recovery path, and a regression test
  that injects the failure and asserts the recovery.
  [failure-catalog.md](failure-catalog.md) is the map.

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
- `npm test` passes 81/81.
- Triage evaluation is honest about model limits: the rule baseline is exact, and a
  per-model prompt dictionary lifts Qwen2.5 0.5B from 6/12 to 12/12 with zero unnecessary
  escalations — measured, not assumed, with the failures (a principles prompt collapsing
  1.5B to all-escalate) recorded in the evaluation doc. A held-out set of nine independent
  cases confirms the rules stay at 9/9, but no model beats them (0.5B 9/9, 1.5B 8/9,
  3B 9/9), and each model adds hundreds of milliseconds of latency.
- The first measured positive increment comes from the task the rules genuinely cannot
  do: extracting failure signals from free-text error strings. On `gateway-evidence-v1`
  (20 strings, 10 direct + 10 paraphrases), the keyword baseline scores recall 0.50 with
  precision 1.00 — it catches every direct phrase and misses every paraphrase. The models
  recover the paraphrases (1.5B recall 0.90, 3B 0.85, 0.5B 0.75) at a small precision cost
  (0.71–0.94). The baseline and split are locked by a unit test.

## Not done (and why)

- **Mainnet acceptance run.** The code path and config switch exist (`GATEWAY_NETWORK=arc`
  resolves the mainnet chain, RPC, contract, and API), but real funds are intentionally
  out of scope — validation stays on testnet.
- **Multi-writer scale-out.** The concurrency model is correct across processes that share
  one PostgreSQL instance (`SKIP LOCKED` + leases + advisory locks). It is not yet
  sharded across databases or backed by a message queue; those are the next production
  milestones, in that order.
- **Operator-time measurement.** The triage evaluation measures decision correctness and
  evidence, not the time saved in production.
