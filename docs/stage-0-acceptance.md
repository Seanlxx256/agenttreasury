# Stage 0: trustworthy approval and evidence boundaries

This milestone closes correctness gaps in the existing testnet scope. It does
not add mainnet acceptance, real-money operation, wallet-native policy claims,
new settlement protocols, or a new model benchmark.

## Invariants and regression evidence

| Invariant | Enforcement | Regression evidence |
| --- | --- | --- |
| Closing a delivery dispute or recording a refund does not resolve a subsequent payment conflict. | The review queue retains the latest decisive payment conflict regardless of delivery closure; later lookup outages do not hide it. | `gateway-dispute-console.test.ts`: dismissed and refunded cases reappear after conflicting evidence. |
| A merchant-bound grant authorizes an address and its approved version. | Both pre-signing and pre-submission grant checks compare the merchant address and version. A -> B -> A leaves the old grant invalid. | `gateway-budget.test.ts`: old grant rejected after A -> B -> A; only current-version reauthorization restores it. |
| Finance approves the specific version it reviewed. | Reauthorization requires `expectedRecipient` and `expectedVersion`; each pending address proposal gets a new sequence number, including replaced proposals. | Recipient helper and HTTP tests reject stale versions, missing versions and operations-role approvals. |
| A model interpretation is never promoted to a verified fact. | Recorded facts and unverified keyword/model inferences are separate arrays; inferences carry observation references and quotes and cannot satisfy action citations. | `gateway-evidence-triage.test.ts`: a wrong interpretation of a negated sentence remains unverified and cannot be cited as a fact. |
| Advisory triage is reproducible without changing payment state. | Each review saves facts, inferences, rule action and model response in separate JSON columns; GET retrieves the latest snapshot. | Dispute console tests compare the API response with the stored snapshot and reject unauthenticated reads. |
| Finance can inspect what it is approving. | The console shows the buyer assertion, delivery assessment, original payment address, current grant address/version and merchant address/version before enabling approval. Text is rendered without HTML interpretation. | `finance-console-ui.test.ts` exercises acknowledgement, displayed versions, request payloads, inference labels and role-specific actions using a DOM boundary harness. |
| Unknown payment outcomes do not authorize a second payment. | Existing request-ID/nonce binding, reservations and submission markers remain authoritative. | Existing purchase, recovery, budget and refund regression tests continue to run in the full suite. |

The UI harness tests behavior, not browser layout. Quote matching establishes
provenance, not semantic truth. A suggested `close-case` remains advisory and
does not update the payment or close a work order.

## Upgrade and API changes

Stop the API and workers before upgrading so older processes cannot continue
using address-only authorization. Build, apply migrations to the intended local
database, then restart all processes:

```sh
npm run build
# DATABASE_URL must point to the intended database.
npm run migrate
```

Migration `032` adds grant approval versions and a monotonic merchant proposal
counter. Grants for unchanged merchants with matching addresses and networks
are backfilled to version 0. Existing grants for merchants with an address-change
history remain unapproved (`NULL`): their historical approval version cannot be
inferred safely, so finance must explicitly reauthorize them. Historical payment
records are not rewritten and read-only recovery does not create new authority.

Migration `033` creates advisory triage review snapshots. It does not represent
a new payment authorization or independently verified model decision.

`POST /finance/gateway-grants/:taskId/recipient-reauthorize` now requires:

```json
{
  "expectedRecipient": "0x...",
  "expectedVersion": 2
}
```

Use the current merchant address and approved version shown by the purchase
detail endpoint. A stale response requires a fresh review, not an automatic
retry with silently refreshed approval terms.

`POST /finance/gateway-purchases/:id/triage` saves a review and returns
`reviewId`, `reviewedAt`, `facts`, `inferences`, `rules` and `agent`.
`GET` on the same path retrieves the latest saved review. Both require an
operations or finance session. Facts describe records and reported statuses;
inferences always have `verification: "unverified"` and source references.

## Validation and next milestone

Run `npm test` for the full PostgreSQL, HTTP, model-boundary and UI-handler suite.
Tests use temporary databases and simulated external responses; they do not
submit blockchain transactions or establish production ROI.

Stage 1 adds a durable reconciliation-case lifecycle, stable anomaly identity,
operational telemetry, CI and restart/backup recovery evidence. A continuous
operator workflow and production operating metrics are not claimed by stage 0.
