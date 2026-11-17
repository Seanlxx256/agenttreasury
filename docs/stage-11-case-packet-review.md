# Stage 11: operator review and versioned follow-up evidence

Case preparation now has an operator feedback loop. Operations and finance users
can replace the candidate topic selection, explain their correction, append
source-labelled material, and save a new packet. The new packet refreshes the
bounded local snapshot and shows which records and topics changed. It never
changes a payment, refund, budget, dispute or reconciliation case.

## Operator workflow

1. Open a Gateway purchase in the finance console. Prepare its first packet or
   select **View saved case packet** to load the latest version.
2. In **Review topics and append evidence**, select the topics that need follow-up.
   These selections replace the model/keyword candidates for question generation.
   Clear an incorrect topic to remove its question. Clearing every topic creates
   no follow-up questions; it does not close the case or disprove any complaint.
3. Enter a required review rationale. Optionally add a merchant reply, customer
   reply or operator observation, with a support-ticket reference and excerpt.
   Redact credentials and personal data before submission. References are inert
   text; the application never follows an entered URL or transaction hash.
4. Select **Save reviewed version**. Inspect the refreshed local facts, topic
   changes, record changes and new evidence IDs. The merchant inquiry remains
   an unsent draft. Supplemental claims do not automatically satisfy evidence gaps.
5. Use **Browse packet history** to inspect earlier immutable snapshots. Historical
   views are read-only; reload the latest saved packet to review again.

Original statements, accepted model output and previous supplemental material
are retained. Review does not call the model again. The stored model interpretation
refers to the original statements, not newly appended evidence. Its original claim
sources are retained separately, so a changed dispute record cannot silently
rebind an old model quotation to new text. Operator selections
have `topic-selection-only` verification; neither human selection nor an exact
model quote proves the underlying assertion. A new merchant refund claim is still
unverified even when it includes a well-formed transaction reference.

## Persistence and concurrency

Migration `040_gateway_case_packet_lineage.sql` adds `parent_id`, a same-request
foreign key and a unique successor constraint. Existing Stage 10 rows remain
unchanged with null parents; their earlier ordering is visible in history, but
lineage is not invented retroactively. Every new API write takes a transaction
advisory lock for the request and checks the expected latest packet before insert.
Two reviewers submitting the same version produce one saved revision and one
HTTP 409 `CASE_PACKET_VERSION_CONFLICT`. A second initial creation also conflicts;
it cannot reset operator corrections or drop supplemental material.

The previous append-only UPDATE/DELETE trigger still applies. These are database
and API constraints under the application's trust boundary, not externally anchored
immutability against a privileged administrator. Actor provenance identifies the
shared authenticated role, not an individual or authenticated merchant identity.

Version checks protect packet lineage, not a lock on live financial records.
Snapshots are read in one read-only repeatable-read transaction and checked again
before append. Later changes can occur; `staleAtCompletion`, `staleNow` and
`freshnessCheckedAt` express the bounded check, not a continuously fresh guarantee.
Record changes compare JSON content regardless of key order. A record leaving the
bounded observation window appears as removed; this does not prove database deletion.

## API

All routes require operations or finance credentials and return `Cache-Control:
no-store`. Agent/task credentials cannot write or read packets. The existing global
console scope is unchanged; this is not tenant isolation.

- `POST /finance/gateway-purchases/:id/case-packet`: initial packet only; existing
  packets require revision instead.
- `GET /finance/gateway-purchases/:id/case-packet`: latest saved packet.
- `POST /finance/gateway-purchases/:id/case-packet/revisions`:

```json
{
  "expectedPacketId": "42",
  "topics": ["delivery-unusable"],
  "note": "The customer withdrew the duplicate-charge complaint; access still fails.",
  "supplements": [
    {
      "kind": "customer-reply",
      "reference": "support-ticket-88/reply-2",
      "text": "The second debit belongs to a different order. This download still fails."
    }
  ]
}
```

- `GET /finance/gateway-purchases/:id/case-packet/history`: up to 20 metadata rows
  plus `nextBefore`; pass `?before=<nextBefore>` for older rows.
- `GET /finance/gateway-purchases/:id/case-packet/history/:packetId`: one complete
  saved packet, strictly scoped to the request and labelled as a historical view.

Review notes are nonblank and at most 1,000 characters. Each revision accepts up
to three supplements, each with a nonblank reference (300 characters maximum) and
excerpt (1,500 maximum). The UI adds one at a time. A lineage holds at most thirty
supplements; beyond that, HTTP 409 `CASE_PACKET_SUPPLEMENT_LIMIT` requires a separate
future archival workflow. The existing 8-KiB HTTP body limit also applies. IDs,
timestamps, role and unverified provenance are assigned server-side. Extra fields,
duplicate/unknown topics and caller-supplied verification states are rejected.

A lost response can be recovered by loading the latest packet. Replaying an old
revision receives a conflict and never creates a duplicate version; there is no
separate client idempotency key that returns the original response.

## Upgrade and validation

Readiness requires schema version 40. `finance:local` applies migrations on startup.
For a separately configured local/test database, stop services, run `npm run build`
and `npm run migrate` with the existing intended `DATABASE_URL`, then restart.
Implementation testing uses disposable databases; it does not migrate or restart
the user's running services and makes no chain or wallet calls.

`npm test`: **233/233 passed**, zero failures or skips, approximately 31.7 seconds
excluding build. `git diff --check` passed. Frozen Stage 7–9 checks remain passing.

Regression coverage includes topic correction, negation recovery by explicit human
review, inherited unverified evidence, unchanged financial tables, stale local
record diffs, historical immutability, one-winner concurrent revisions and initial
creation, foreign-request rejection, input/provenance injection rejection, material
limits, paginated history, and console submission/text rendering. Console tests
use the existing DOM harness, not a visual browser acceptance test.

## Remaining value validation

This completes the first operator editing loop, not proof that the model saves
work. The observed Stage 10 model errors still apply and model extraction remains
disabled by default. Next, instrument review effort and define a separate evaluation
of unsupported assertions, missing materials, correction count and preparation time.
Automated simulations must be labelled as simulations; they cannot establish actual
human time savings or independently reviewed semantic accuracy. Multi-order inquiry,
automatic merchant messaging, automatic refund verification and document ingestion
remain outside this slice.
