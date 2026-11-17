# AgentTreasury project highlights

AgentTreasury is a TypeScript, Fastify and PostgreSQL portfolio project for controlled
agent payments and payment operations. A task-scoped buyer purchases API access on
Arc testnet using Gateway; the backend retains uncertain reservations, recovers the
original delivery and reconciles payment evidence. An optional agent prepares
read-only investigation suggestions and reviewable case material.

## Engineering value

- Built transactional task/daily budget reservations, grant and recipient-version
  validation, durable request/nonce identity and bounded recovery workers. Lost
  responses do not justify releasing budgets or issuing a new payment authorization.
- Separated the executable signer from the buyer and constrained its input to stored,
  authorized terms. Tested concurrent retries, revocation, lost responses and process
  restart. The local key-file/shared-DB setup is not HSM custody or OS isolation.
- Implemented payment/refund journals, batch and wallet-window reconciliation,
  replayable evidence, durable discrepancy cases and a cold-backup restoration drill.
  Conflicts remain visible rather than becoming silently accepted accounting changes.
- Added operator-controlled disputes, evidence-gated refunds and at-most-once automatic
  refund broadcast. Unknown broadcast outcomes require investigation before recovery.
- Built source-bound exception packets, append-only revisions, provenance-labelled
  supplements, context/disagreement holds and role-authenticated review. Candidate
  text never becomes a financial fact or payment authority merely because it is quoted.
- Evaluated local models against deterministic controls, retained raw failures and
  pinned evaluation inputs/code/model identity. Added annotation import and reviewer
  disagreement tooling without asserting that self-declared review is independent.

## Evidence that can be shown

The [final acceptance report](evidence/portfolio-acceptance.json) records the current
complete test count, runtime, individual verification steps and source/build hashes.
It includes local PostgreSQL and HTTP fault-injection tests and offline replay of
historical Arc testnet evidence. It does not create a new chain payment.

The [modern testnet capture](stage-6-signing-acceptance.md) recorded one 0.001 test-USDC
purchase through the separate signer and actual buyer executable: one signature,
one payment journal entry, saved delivery, spent budget and a corroborated batch.
Resuming the same request retained that identity and spend. The seller and trace
were project-operated fixtures, not an independent commercial provider.

The [Stage 13 development comparison](stage-13-case-packet-evaluation.md) did not
establish a stable model benefit: template/model-assisted topic matching was 4/12
versus 5/12, while exact question-category coverage remained 5/12. Later context
holds improve review boundaries, not the underlying model's semantic accuracy.
No human review reduction or production time saving is claimed.

## Resume wording

Use these as project bullets, not employment or production-scale claims:

- Developed a TypeScript/PostgreSQL agent-payment backend with task budgets,
  request/nonce idempotency and evidence-based recovery for uncertain Gateway
  testnet payments; validated concurrency, revocation and lost-response behavior
  through fault-injection tests.
- Implemented a separate constrained signer, balanced payment/refund accounting,
  batch/balance reconciliation and replayable operational evidence; exercised an
  end-to-end 0.001 test-USDC purchase and repeat-request recovery.
- Built read-only agent investigation and versioned exception-case preparation with
  cited evidence, operator review and reproducible rule/model evaluation; retained
  unsuccessful model results and kept model suggestions outside fund execution.

## Interview explanation

A useful starting point is the failure window: a paid request times out, so the
buyer cannot safely assume either success or failure. Explain the persisted request
and authorization, retained reservation, nonce lookup, matching evidence, original
result retrieval and the eventual journal entry. Then show why a model may help
organize ambiguous statements but must not decide whether money moved.

Be ready to explain the tradeoffs: one authorization per logical request, at-most-once
broadcast under uncertainty, bounded read snapshots, coarse shared role identity,
local key custody and conservatively increased human review. The project shows
backend correctness work and evaluation judgment; agent productivity remains an
unverified hypothesis. See the [proposal acceptance matrix](stage-16-portfolio-acceptance.md)
for precise scope changes and unimplemented original aspirations.
