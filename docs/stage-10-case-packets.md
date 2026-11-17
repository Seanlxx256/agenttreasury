# Stage 10: payment exception case preparation

The first application slice of the new direction is available in the finance
console. An operations or finance user opens an existing Gateway purchase,
enters the customer's complaint and the merchant's reply, and prepares a saved
case packet. This uses the application's database, authenticated HTTP API and
operator UI, rather than another standalone investigation benchmark.

## What the packet contains

| Section | Meaning |
| --- | --- |
| Party statements | Operator-entered customer/merchant text and any stored buyer dispute reason; identities and assertions are not independently verified. |
| Recorded facts | Deterministic descriptions of the local purchase, posting, delivery flags, commitment result and refund workflow/ledger. |
| Candidate topics | Separate keyword and optional model interpretations, each with source references and quotations; always unverified. |
| Evidence gaps | Questions needed to investigate possible duplicate charges, unusable delivery, refund claims or an unclear concern. |
| Merchant inquiry | A draft assembled from the questions, linked to the original request; never sent automatically. |
| Source material | Bounded Gateway observations and request-related audit events, with local record locators and coverage limitations. |

A merchant saying "already refunded" remains a statement. Refund approval or
a broadcast marker is not treated as a local refund posting. A saved delivery
does not establish that its contents are usable, and one local payment posting
cannot exclude a charge under another order or outside the system. A recorded
refund transaction is described as a local ledger record, not freshly verified
onchain evidence. The report grants no financial authority or case resolution.

The source collector uses one `REPEATABLE READ READ ONLY` transaction. It
selects an explicit field allowlist: no retrieval tokens, signing credentials,
bearer signatures, raw delivery bodies or arbitrary dispute/audit payloads.
Observation coverage is the latest ten plus the latest consequential
charged/failed/conflict record. Audit coverage is at most fifty events from
the purchase, refund-request and delivery-dispute entities; truncation is
explicit. This is not complete account history or audit-chain verification.

Each saved packet includes the source snapshot and a fingerprint. Sources are
read again after model processing and on retrieval of a saved report; changes
mark it stale without rewriting the original. Freshness refers to this bounded
local view as of the check time, not current chain state. New reports append to
history. The API returns the latest packet, while earlier versions remain in
the database. [Stage 11](stage-11-case-packet-review.md) now adds a history browser
and operator correction workflow; initial creation is limited to one packet per request.

## API and authority

`POST /finance/gateway-purchases/:id/case-packet`

```json
{
  "customerStatement": "I was charged twice and cannot open the purchased data.",
  "merchantStatement": "We already refunded the order."
}
```

Both fields are required, may be empty, and are limited to 3,000 characters
each; the existing 8-KiB request-body limit also applies. Extra request IDs,
model names, URLs, source selectors or financial actions are rejected. The
purchase target comes exclusively from the authenticated route. Existing
operator roles can access all console purchases; this does not add tenant or
per-person access control. The recorded actor is the role, not an individual.

`GET` on the same path returns the latest saved report and `staleNow`.
Both routes require finance or operations credentials and send `no-store`.
No external merchant request, payment, refund, budget update, dispute decision
or case transition is performed. The only write is an advisory packet row.
Database triggers prevent ordinary UPDATE/DELETE of packets, but a privileged
database owner can bypass that mechanism. This is not externally anchored
immutability.

## Optional semantic interpretation

By default, the packet works without a model. The keyword baseline only
recognizes a few English phrases and can misread negation. Its topics are
candidate investigation subjects, not verified assertions.

To experiment with local model extraction, set `GATEWAY_CASE_PACKET_MODEL`
on the API process, for example `qwen2.5:3b`. The adapter calls only local Ollama
and sends party text, not the payment snapshot or wallet credentials. It can
return only a topic, a claim-source ID and an exact quotation. Unknown sources,
fabricated quotes, duplicate entries, extra fields and action instructions are
rejected. Topic interpretations remain unverified even when the quote exists:
a quote proves where text came from, not that the topic correctly interprets it.

The source statements and valid rule/model candidates are preserved separately.
Draft questions use the union of candidate topics; a model failure does not
hide the original complaint or silently become model success. The UI displays
the model status and validated issues. Bounded raw model text, rejection reason,
token counts and termination reason are retained in the protected report for
diagnosis, not rendered as the operator's factual conclusion.

This first version has one optional classification call and deterministic
record collection/template assembly. It is not yet an autonomous multi-turn
investigator, free-form report writer, merchant messaging agent or refund
negotiator. The endpoint does not fetch a merchant-supplied transaction hash
or ingest external documents automatically.

## Upgrade and use

Migration `039_gateway_case_packets.sql` adds the advisory report table. Readiness
required schema version 39 at this stage; the current application requires version 40. Stop the API/workers before upgrading, then:

```sh
npm run build
# DATABASE_URL must point to the intended existing local/test database.
npm run migrate
# Restart the API and workers using their existing configuration.
```

The embedded `finance:local` launcher runs migrations during startup. In the
console, open a Gateway purchase and use **Prepare an exception case packet**.
Enter the two statements, select **Prepare case packet**, and inspect the
recorded facts, unverified topics, questions and unsent inquiry. **View saved
case packet** reloads the latest snapshot and displays a stale warning when
the source records have changed.

No existing user database was migrated or restarted during implementation;
database validation used temporary PostgreSQL instances.

## Verification and current limits

`npm test`: **229/229 passed**, no skips, approximately 32 seconds excluding
build. The new tests verify SELECT-only collection, secret/foreign-order
exclusion, unchanged financial tables, authenticated API access, extra-field
rejection, append-only reports, stale snapshot detection, bounded evidence,
model quote/action validation and console text rendering. The UI check uses
the existing DOM harness; no visual browser acceptance is claimed. Frozen
Stage 7–9 checks continue to pass.

The local 3B integration smoke check uses three invented statement pairs:
compound complaint, paraphrase, and negative context. The [first capture](evidence/stage-10-case-packet-smoke.json)
retains the initial observed failures. After adding raw-output diagnostics,
the [diagnostic capture](evidence/stage-10-case-packet-diagnostics.json) repeats
the same text without changing the prompt or assigning new evaluation scores.
These are integration checks, not an independently reviewed benchmark.

In the initial check, the model omitted the delivery issue from the compound
complaint, its paraphrase output failed the quote/shape gate, and it mislabeled
negative statements as duplicate-charge/refund topics. The keyword baseline
also mishandles negation. Consequently the model stays disabled by default;
no operator-time saving or superior semantic accuracy is claimed.

The smoke script is in the repository and uses no wallet or database:

```sh
npm run build
node scripts/check-case-packet-model.mjs --output /tmp/new-case-packet-smoke.json
```

Use a new filename; existing reports are never overwritten. Captures contain
synthetic text only. Real party statements are sensitive operator data and
should stay in the authenticated case workflow.

## Next step

Operator confirmation/correction and versioned follow-up evidence are now implemented
in [Stage 11](stage-11-case-packet-review.md). New materials retain their source and
verification status; regenerated packets show explicit version differences. The
next step is to measure missing evidence, unsupported assertions and operator edit
effort before claiming an advantage over template-only preparation.
Multi-order duplicate-charge investigation requires an explicit, authorized
link between requests and remains outside this single-request first slice.
