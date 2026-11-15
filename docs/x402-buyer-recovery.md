# x402 buyer recovery semantics

This document defines the buyer side of an x402 payment when the HTTP exchange does not complete. It is derived from the Gateway Nanopayments implementation in this repository and covers the state machine, evidence requirements, idempotency rules, and the cases that require human intervention.

Payment acceptance, delivery, and onchain settlement are three events that can arrive in any order. A buyer that posts a signed authorization and loses the response must establish whether it paid, recover the resource when possible, and never submit a second charge for the same request. The same logic applies on a retry with the original request ID.

## Invariants

1. **Persist before submit.** The request ID and authorization nonce are written to the database before the authorization is signed and submitted. There is no path that submits a nonce the database does not already know.
2. **One authorization per request.** The claim row is inserted with `ON CONFLICT DO NOTHING`; only the process whose insert wins may sign and submit. A concurrent retry either returns the stored result or observes the current status.
3. **Never replay an ambiguous POST.** If the merchant response is lost, the buyer does not post the authorization again. It looks the nonce up through the Gateway and only takes the recovery action that matches the observed evidence.
4. **Missing evidence is not conflicting evidence.** An empty lookup, a failed lookup, and a contradiction are different outcomes. The first two are retryable; the last requires a person.

## Buyer state machine

The buyer maps a Gateway observation onto a terminal or recoverable status.

| Buyer status | Gateway observation | Evidence | Next action |
| --- | --- | --- | --- |
| `delivered` | `charged` | saved delivery matches the request | none; purchase is complete |
| `submission-unknown` | `unknown` or `unavailable` | no transfer found, or the lookup failed | query the nonce again; do not re-submit |
| `payment-pending` | `pending` | transfer accepted but not settled, no batch hash | keep polling; the authorization stays reserved |
| `charged-delivery-missing` | `charged` | charge confirmed, buyer delivery absent | recover via retrieval token; if recovery fails, request a refund |
| `payment-failed` | `failed` | transfer reported failed | release the budget reservation |
| `reconciliation-conflict` | `conflict` | multiple transfers, or a mismatch, or an accounting mismatch | stop and escalate; never auto-settle |

`submission-unknown` is the default exit code after a lost response. It means "we do not know yet", not "we did not pay". `reconciliation-conflict` is the only state that forbids an automatic next step.

## Gateway observation model

A nonce lookup requests `GET /v1/x402/transfers?nonce=<nonce>&network=<network>&pageSize=2`. The response is reduced to one of six observations.

| Observation | Meaning | Condition |
| --- | --- | --- |
| `unknown` | no transfer exists for the nonce | empty transfers page |
| `pending` | accepted, not yet settled | status `received` or `batched`; batch hash may be absent |
| `charged` | settled onchain | status `confirmed` or `completed` with a valid batch hash |
| `failed` | the transfer failed | status `failed` |
| `conflict` (`multiple-transfers`) | more than one record for the nonce | transfers length > 1 or a `pageAfter` cursor |
| `conflict` (`transfer-mismatch`) | the record does not match the authorization | payer, recipient, token, network, or amount differs |

`unavailable` is not an observation type: it is the outcome when the lookup itself throws or returns a non-2xx response. It collapses to `submission-unknown` because the correct retry is the same nonce query, not a decision.

## Conflict vs unavailable

These two failures look similar and are treated differently.

| Outcome | Cause | Is a retry safe? |
| --- | --- | --- |
| `unavailable` | HTTP error, timeout, invalid response body | yes; the same read is idempotent |
| `conflict` | evidence contradicts the stored authorization or the ledger | no; a person must reconcile |

The buyer can retry `unavailable` indefinitely. It must not retry its way through a `conflict`.

## Accounting check on a terminal observation

When the observation is `charged` or `failed`, the buyer also verifies the local accounting before it moves budget. A `charged` observation is only applied when all of the following hold:

- the purchase has a submission marker;
- the budget row is still `reserved`, or already `spent` with the same terminal state;
- for a `charged` observation, the journal row is newly inserted (one row) or already present with the same transfer ID and batch hash.

If the observation is `charged` but the accounting does not match, the result is `conflict` with reason `accounting-mismatch`. The transfer ID and batch hash recorded against the journal must equal the ones reported by the Gateway. A mismatch means the payment happened somewhere that the ledger cannot explain.

## When a person must intervene

Automatic recovery stops at three boundaries.

1. **`reconciliation-conflict`** — multiple transfers, a mismatched transfer, or an accounting mismatch. The system will not guess which record is authoritative.
2. **`charged-delivery-missing` with a failed recovery** — the Gateway confirms the charge and the buyer cannot retrieve the seller's saved delivery with the retrieval token. The buyer has paid and the goods exist but are unreachable; the buyer can open a refund request (below) or a human can contact the seller out of band.
3. **Exhausted polling** — a `pending` observation that does not settle within the reconciliation window. The reservation stays in place and the case is surfaced for review rather than silently closed.

## Gateway refund

When a charge is confirmed and the delivery stays missing, the buyer can open a refund instead of holding an unrecoverable paid-but-empty purchase. The Gateway rail mirrors the Base rail's refund loop — approval, seller-initiated return, and onchain evidence — but keys off the batched charge instead of a payment intent.

1. **Request and approve.** `gateway_refund_requests` holds the approval state. The agent calls `requestGatewayRefund`, which only succeeds when `gateway_payment_journal` already records the charge and neither the buyer nor the seller holds a delivery. A finance operator then approves or denies it (`decideGatewayRefund`), with both steps written to the audit history.
2. **Return the funds.** Circle Gateway has no first-party refund endpoint, so a refund is the inverse of the batched charge: the seller moves the same USDC amount back to the payer's address. `npm run gateway:refund -- <requestId> <reason>` signs and broadcasts a plain USDC transfer and records the submitted hash in `gateway_refund_authorizations` so an interrupted run can resume without double-paying.
3. **Prove it.** `recordGatewayRefund` verifies the same evidence rules as the Base rail's `recordRefund`: a later, finalized USDC `Transfer` from the seller recipient to the payer for exactly the charged amount, posted after the original batch, with stable block hashes. The proof lands in `gateway_payment_refunds` and reverses the journal in `gateway_refund_journal_lines`.

The refund request requires the charge to exist and the delivery to be absent, and it refuses both a duplicate request and a refund of an already-delivered purchase, so the rail can never both deliver and refund the same charge.

## Idempotency and concurrency

- The logical request ID is unique per purchase. Replaying the same ID returns the stored delivery or the current status instead of creating a second authorization.
- The authorization nonce is unique in the database, so the same signed authorization cannot be claimed twice.
- The budget reservation is taken inside the same transaction that claims the purchase row, so a lost response leaves the amount reserved and visible for reconciliation.
- On the seller side, the delivery row is claimed before the facilitator settle call. If the settle call fails after the claim, the request is already spent and returns a conflict rather than being settled twice.

## Verification

Recovery is confirmed in three layers, each independent of the others:

1. **Nonce level** — the Gateway transfer for the nonce matches payer, recipient, and amount.
2. **Batch level** — the deltas decoded from the `submitBatch` calldata reconcile with the local journal entries for the same batch.
3. **Balance level** — the Gateway total balance at the boundary blocks, plus capital movements, matches the independently computed onchain balance.

A purchase is `PASSED` only when the Gateway observation is `charged`, the journal posts one debit and one credit that both reference the same transfer and batch, the budget is `spent`, and the buyer and seller hold identical saved deliveries.

## Reproduce

The state machine is exercised without network access by `npm run demo:offline`, which drops the paid response once and then recovers: `submission-unknown` → `delivered` → `PASSED`.
