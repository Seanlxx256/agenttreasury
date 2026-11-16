# Stage 5 batch acceptance and request linkage

Follow-up: [Stage 6](stage-6-signing-acceptance.md) validates a new order with
original authorization fields. The legacy missing-authorization result below
remains unchanged.


This step captures two actual Arc testnet batches and replays their raw event
logs, calldata and wallet balances. One sample is public chain-only evidence;
the other joins an existing project journal with a fresh Gateway observation.
No new payment, refund, signature or migration was executed.

## Observed acceptance results

| Evidence | Public batch | Existing project purchase |
| --- | --- | --- |
| Artifact | [Public sample](evidence/stage-5-live-batch.json) | [Project sample](evidence/stage-5-project-batch.json) |
| Capture time (UTC) | 2026-11-16 17:46:27 | 2026-11-16 18:19:19 |
| Block | 72581208 | 72412969 |
| Batch transaction | `0x33591d813d82c7d71e01586c6fcc4b1d22d34a37c4f77fa6c83a16080610be33` | `0xd9f44121ba01e996fd38319dddad6e2a77d366e95e99e6889c183c7acf780ebe` |
| Batch participant entries | 3 | 5 |
| Wallet delta (USDC base units) | -132 | -1000 |
| Opening balance | 3289473 | 499000 |
| Closing balance | 3289341 | 498000 |
| Chain difference | 0 | 0 |
| Local journal supplied | No | Yes, 1000 units in this window |
| Balance report | DISCREPANCY: no local journal | MATCHED |
| Original authorization fields | Not supplied | Absent in the legacy database |
| Request linkage result | Not applicable | incomplete |

The public sample's discrepancy is not evidence of a merchant or accounting
incident. Its journal was intentionally absent. The project sample uses request
`0c7b7fbc-e93b-4fa4-a297-373ea8852b90`: the stored request terms, journal amount,
current Gateway transfer ID/batch reference, raw batch and wallet accounting
agree. However, the original signing authorization was not saved by that old
version, so the report preserves `authorizationTerms: unavailable` and
`status: incomplete`. It does not fabricate an authorization from a matching
payment record.

The local Gateway and finance databases predate migration `020` and lack the
explicit network column. Initial read attempts failed with PostgreSQL `42703`.
The reader now applies the same legacy testnet default specified by migration
`020`, only for a pre-020 database, and exports
`networkProvenance: legacy-pre-020-testnet-default`. It does not migrate the
running data. The successful capture used the existing Gateway database,
started temporarily with only a read-only client and stopped afterward. No
payment workers or signer process were launched. DB credentials are used only
for the local connection and are not exported; private keys are not loaded.

## What the additional validation establishes

Saved batches are re-decoded before persistence and replay. Checks bind the raw
`BatchProcessed` event's batch ID and token to the direct `submitBatch` calldata,
validate domain/token/Gateway contract, check that all deltas sum to zero, and
recompute the selected wallet's delta. Incorrect normalized deltas are rejected
even if someone regenerates their snapshot digest and accounting report.
Legacy snapshots without raw calldata remain explicitly unavailable for this
additional validation. Digests are local integrity checks, not externally
anchored attestations or receipt inclusion proofs.

Investigation output now separates:

- Historical request terms versus the current request.
- Saved original authorization fields versus current payer, recipient, amount
  and nonce. This is field consistency, not signature verification.
- Current and captured journal amount, batch reference and spent status.
- Normalized Gateway transfer ID and transaction reference, including conflicts.
- Aggregate wallet accounting and raw batch consistency.

Agreement is labeled `corroborated`, a mismatch is `conflict`, and missing
required evidence is `incomplete`. The output always carries
`cryptographicAuthorizationInclusion: false`. Batch calldata exposes net wallet
deltas, not individual payment nonces. Two different payment allocations can
produce the same net delta; the tests demonstrate this explicitly. No result
authorizes payment, refund, ledger mutation or automatic case closure. Payee
cryptographic verification remains an agreed scope exclusion.

## Reproduction

```sh
npm run build
npm run capture:gateway-balances -- --replay docs/evidence/stage-5-live-batch.json
npm run capture:gateway-balances -- --replay docs/evidence/stage-5-project-batch.json
```

Both commands are offline and need neither a database nor wallet credentials.
The project archive also has a digest over the whole capture, including local
terms and the Gateway observation; replay recomputes its linkage assessment.

For a new, bounded public capture:

```sh
npm run capture:gateway-balances -- --discover-batch /tmp/arc-batch-sample.json
```

For an existing local project purchase (optional UUID; default is latest
journal posting), with no migration or new payment:

```sh
node scripts/capture-local-gateway-batch.mjs /tmp/project-batch.json [existing-request-id]
node scripts/capture-local-gateway-batch.mjs --finance /tmp/finance-batch.json [existing-request-id]
```

These scripts refuse to overwrite output files. The local capture uses read-only
sessions, starts an existing database only when needed, and stops only the
instance it started. All exported authorization fields are explicitly selected;
signatures, access tokens, delivery bodies and credentials are omitted.

## Tests and remaining acceptance

Full suite on 2026-11-17: **191/191 passing**, no skips, approximately 28 seconds
excluding build. Added coverage includes both real batch archives, PostgreSQL
persistence and offline replay, raw-data inconsistency despite recomputed
hashes, wrong nonce/amount/recipient/transfer/batch references, missing evidence,
alternate payment allocations and the real project archive reaching the
SELECT-only investigation runner. The final integration test imports archived
facts into a disposable database; it does not mutate the original project DB.

The new linkage checks are deterministic backend evidence checks, not a new
model benchmark or proof of agent ROI. No independent human labels, operator
time reduction, production incident or new model scores are claimed. Real
original-authorization acceptance remains incomplete for this legacy purchase.
Next: run acceptance on a testnet purchase recorded by the newer signing
boundary, then freeze reviewed investigation cases covering complete, missing
and conflicting evidence. The agreed mainnet/real-money and other version
exclusions remain unchanged.
