# Failure catalog — governing the failure window, not just the happy path

x402 and Circle Gateway give every payment the same happy path: a `402` quote, an
offchain `EIP-3009` authorization, a retry carrying the signed payload, and a batched
settlement. Nobody has standardized what happens when that sequence breaks — when the
response is lost, when the chain reorganizes, when a batch reverts, or when the money
moved but the delivery is wrong. AgentTreasury's differentiation is that it treats
those failure states as first-class: each one has a detection mechanism, a recovery or
governance path, and a regression test that *injects* the failure and asserts the
recovery.

The table is the map; the sections below each row explain the mechanism and point to
the test that proves it.

| # | Failure mode | Detected by | Governed / recovered by | Proven in |
|---|---|---|---|---|
| 1 | Lost paid response | `submission-unknown` state | nonce-keyed Gateway lookup, no resubmission | `payments.test.ts` |
| 2 | Double charge | request-id + nonce uniqueness | idempotent reuse, never re-sign/re-pay | `payments.test.ts` |
| 3 | Ledger mismatch | dual-ledger reconciliation | `DISCREPANCY` report with located batches | `payments.test.ts` |
| 4 | Wrong refund evidence | onchain log validation | reject `INVALID_REFUND_EVIDENCE` | `gateway-refunds.test.ts` |
| 5 | Reverted batch | batch receipt status | `FAILED` with explicit problem | `payments.test.ts` |
| 6 | Chain reorganization | finalized-block hash stability | abort reconciliation, refuse to misreport | `payments.test.ts` |
| 7 | Contradictory transfer evidence | transfer search matching | `conflict` state for review | `gateway-reconciliation.test.ts` |
| 8 | Failed transfer | transfer `failed` status | `payment-failed`, release the reservation | `payments.test.ts` |
| 9 | Submission timeout | `reconcile_after` lease + attempts | expire or escalate to human review | `payments.test.ts` |
| 10 | **Paid but wrong delivery** | — not implemented — | — not implemented — | **gap** |

## 1. Lost paid response

The buyer POSTs the signed payment and the connection drops before the delivery comes
back. Neither side knows whether the money moved.

- **Detection.** `purchaseGatewayTrace` returns `submission-unknown` when the retry
  POST is interrupted, and persists the authorization nonce before submitting.
- **Recovery.** The next attempt finds the existing row, looks the nonce up on the
  Gateway, and either recovers the delivery with the saved retrieval token
  (`charged-delivery-missing` → `delivered`) or reports that it was never charged —
  without ever signing or submitting a second time.
- **Proven by.** `Arc buyer recovers lost delivery by nonce without resubmitting
  payment` in `test/payments.test.ts`: the paid response is thrown away, a second call
  reuses the same nonce, and the submission count stays at one.

## 2. Double charge

A retry must not debit the budget or the chain twice.

- **Detection.** The purchase row is keyed on `request_id`, and the insert uses
  `ON CONFLICT (request_id) DO NOTHING`. Concurrent workers claim work with
  `FOR UPDATE SKIP LOCKED` plus a `reconcile_after` lease.
- **Recovery.** A loser of the insert races reads the winner's row and joins its state
  instead of submitting; the reconciliation lease means each due purchase is settled
  exactly once.
- **Proven by.** `two API instances cannot concurrently overspend the same task` and
  the concurrent-worker block inside `Gateway worker reconciles after lease expiry` in
  `test/payments.test.ts`.

## 3. Ledger mismatch

The local journal and the onchain Gateway balance must agree, and when they don't the
difference has to be localizable, not just flagged.

- **Detection.** `reconcileGatewayBalances` reconstructs the chain-side movement from
  `Deposited` / `WithdrawalCompleted` / `GatewayBurned` / `BatchProcessed` logs and
  compares `chainClosing` against `journalClosing`.
- **Recovery.** A mismatch returns `DISCREPANCY` and points at the exact batch
  (`batchDelta` vs `journalDelta`) or the missing batch hash.
- **Proven by.** The `reconcileGatewayBalances` section of `Gateway worker reconciles
  after lease expiry` in `test/payments.test.ts`, which flips a delta from matched to
  `DISCREPANCY`.

## 4. Wrong refund evidence

A refund is a seller-initiated return, so the onchain evidence must prove direction,
amount, and ordering before it is posted.

- **Detection.** `recordGatewayRefund` validates the refund receipt log: token, `from`
  is the seller, `to` is the payer, amount equals the original, and the refund block is
  after the original batch and finalized.
- **Recovery.** Wrong direction, wrong amount, wrong order, and unfinalized refunds are
  rejected (`INVALID_REFUND_EVIDENCE`, `REFUND_NOT_FINALIZED`); identical evidence
  replays are idempotent.
- **Proven by.** `recordGatewayRefund rejects wrong direction, amount, and order` in
  `test/gateway-refunds.test.ts`.

## 5. Reverted batch

Gateway confirms offchain and settles in batches later; that batch transaction can
revert.

- **Detection.** `collectGatewayPurchaseEvidence` reads the batch receipt and treats
  `status: 'reverted'` as a problem.
- **Recovery.** The evidence run reports `FAILED` with `The Arc batch transaction
  reverted.` rather than certifying a delivered purchase.
- **Proven by.** The `collectGatewayPurchaseEvidence` assertions in `Arc buyer recovers
  lost delivery` in `test/payments.test.ts`, which feed a reverted receipt and assert
  `FAILED`.

## 6. Chain reorganization

A finalized block hash changing mid-check is a reorg; reporting balances across it
would produce a fake agreement or a fake discrepancy.

- **Detection.** `reconcileGatewayBalances` requires an end block at or before
  `chain.finalized()`, and re-reads the opening and closing block hashes at the end —
  `Finalized block hash changed during reconciliation` aborts the run.
- **Recovery.** The run throws instead of publishing a report, so finance never acts on
  a snapshot that crossed a reorg boundary.
- **Proven by.** `finalized reconciliation matches once and reports discrepancies on
  both sides` in `test/payments.test.ts`, which makes the opening block hash change on
  a second read and asserts rejection.

## 7. Contradictory transfer evidence

The Gateway transfer search can return nothing, one matching transfer, a transfer whose
amount differs, or several transfers for one nonce.

- **Detection.** `observeGatewayPayment` matches nonce, payer, recipient, token,
  network, and amount, and distinguishes `unknown` / `pending` / `charged` / `failed` /
  `conflict`.
- **Recovery.** A mismatch or multiple transfers become a `conflict` that surfaces for
  review instead of being silently closed as charged.
- **Proven by.** `Gateway lookup requires matching evidence before reporting a failed
  or charged transfer` in `test/gateway-reconciliation.test.ts`.

## 8. Failed transfer

The Gateway itself reports the transfer as failed — the buyer is not charged.

- **Detection.** `observeGatewayPayment` maps a `failed` transfer status to
  `{ status: 'failed' }`.
- **Recovery.** `purchaseGatewayTrace` maps that to `payment-failed` and the reserved
  budget is released, so the task can spend elsewhere.
- **Proven by.** The `rejected` branch of `Arc buyer recovers lost delivery` in
  `test/payments.test.ts`, which asserts the uncharged budget returns to `0 / 0`.

## 9. Submission timeout

A submitted purchase whose outcome stays unknown forever cannot hold budget forever.

- **Detection.** `processGatewayReconciliation` uses a `reconcile_after` lease and a
  `reconcile_attempts` counter; an unsubmitted purchase past its window is
  `submission-expired`.
- **Recovery.** Expired unsubmitted purchases release their reservation; a purchase
  that keeps failing crosses an attempt threshold and is flagged for human review
  (`reconcile_review_at`).
- **Proven by.** `Gateway worker reconciles after lease expiry and preserves uncertain
  budgets for review` in `test/payments.test.ts`.

## 10. Paid but wrong delivery — the honest gap

This is the one failure mode this project does **not** yet govern, and it is the gap
that matters most in the agentic-payments story.

x402 is *pay-then-verify*: the seller checks the signature and serves the resource, and
there is no chargeback or dispute primitive in the protocol. `receiveDelivery` verifies
that the payload has the right `request_id`, `nonce`, `gatewayReference`, and that its
trace originates from the fixture — but it does not, and cannot, verify that the trace's
*content* is what the buyer paid for. A seller that returns a well-formed but wrong or
empty result is indistinguishable, at this layer, from a correct one.

This is intentionally unaddressed in the current scope and belongs to the next work
item: a **dispute loop** — buyer raises a dispute, both sides present payment and
delivery evidence, and a decision (human-approved, matching the project's read-only
triage stance) either records a refund or closes the dispute. The append-only audit
table and onchain evidence verification already built here are exactly the substrate
that loop needs.

## Design stance

The catalog is not a list of features; it is a claim about where correctness has to
live. Two positions follow from it:

1. **Detect late, never lie.** The system does not try to predict the failure at
   submission time. It records the ambiguity, and guarantees that the ambiguity is
   *eventually resolved against the chain and the ledger* — the reconciliation layer,
   not the happy path, is the source of truth.
2. **Humans decide the irreversible steps.** Recovery that just re-reads state is
   automated; anything that moves money back or changes a decision is operator-gated,
   and the triage agent is advisory. The failure path is where autonomy must be
   bounded.
