# Stage 5: persistent balance evidence and offline replay

The testnet balance scanner now saves the inputs needed to reproduce each new
report. Previously it retained the report and cursor, but a later investigation
could not recalculate that result independently of the current ledger and RPC.

## Delivered behavior

- Migration `037` adds append-only event projections, finalized block checkpoints
  and versioned scan snapshots. The scanner rejects non-`arcTestnet` ingestion.
- The RPC adapter retains block number/hash, transaction hash, log index,
  contract address, topics and raw data. Batch events also retain the direct
  `submitBatch` calldata used to derive the wallet delta. RPC sources include
  chain ID and a SHA-256 endpoint fingerprint; credentials and raw URLs are not
  stored. Fixtures are labeled separately; older adapters have a null source.
- The input snapshot includes historical balances, window hashes, finality
  height, normalized movements, the selected purchase/journal rows, receipt
  block lookups and normalized current Gateway observations. Current pending
  authorizations remain separate from historical balance arithmetic.
- Report computation is a pure, versioned replay function. Replay uses the
  saved inputs, not current purchase rows or network calls, and compares the
  recomputed report with the original. A canonical JSON SHA-256 digest survives
  JSONB key reordering and detects input corruption.
- Events are wallet-scoped projections keyed by network, payer, transaction
  hash and log index. Identical persistence is idempotent; different evidence
  for an existing identity fails. Finalized block checkpoints are network-wide.
  Event hashes are checked against RPC block headers during collection.
- Evidence, result, discrepancy cases and cursor advance commit together behind
  the existing attempt fence. A persistence failure rolls back and marks only
  that attempt failed. A restarted scanner retries the original window.
- Duplicate identical RPC logs are ignored; conflicting duplicates fail.
  Multiple wallet-relevant batch events in one transaction are rejected as
  ambiguous rather than matching the same journal group more than once.

## Apply and use

```sh
npm run build
node --env-file=.env dist/src/migrate.js
node --env-file=.env dist/src/gateway-balance-scanner.js <payer-address>
node --env-file=.env dist/src/gateway-balance-evidence.js <scan-id>
```

The scanner emits `scanId`; use it for replay. With `DATABASE_URL` already
exported, the final command is also available as:

```sh
npm run replay:gateway-balances -- <scan-id>
```

Replay needs only database SELECT access, with no wallet key, signer, Gateway
API or RPC access. The CLI sets its database session to read-only. Successful
output includes `verified: true`, the evidence digest, source and recalculated
report. `verified` means consistency with saved inputs and report, not external
attestation of the chain. Legacy scans without snapshots fail explicitly; they
are not backfilled from present-day balances. New unattributed adapter snapshots
are replayable but must not be presented as RPC evidence.

## Validation and limits

Local full-suite verification on 2026-11-17: **178/178 tests passed**, with no
skips (approximately 28 seconds excluding compilation). Tests cover event
idempotency and mutation guards, ledger changes after capture, offline replay,
conflicting event/block evidence, atomic rollback, stale attempts, missing
provenance, mainnet rejection, corrupted input digests and changed reports.
A real PostgreSQL connection is dropped with an uncommitted evidence transaction;
the lease is then recovered. The cold-backup drill restores a saved snapshot to
a separate PostgreSQL instance and successfully replays it.

These are deterministic fixtures and local database recovery tests. No real
Arc RPC event capture, live provider incident, process SIGKILL during ingestion,
24-hour soak or container deployment was performed in this stage. No payment,
refund, signer invocation or funding action is part of this change.

Raw logs/calldata are archived; replay recomputes accounting from the recorded
normalized movements, not from an independent ABI decoder or receipt proof.
Gateway observations are normalized, not archived HTTP responses. Missing-batch
receipt lookups retain block numbers only. One RPC source cannot prove that it
returned every log. Local journal capture and Gateway reads occur at different
times; replay preserves those inputs, not a distributed atomic snapshot.

Append-only triggers protect ordinary SQL writes, not a database administrator
who can disable triggers or replace both evidence and its digest. This is not
an externally anchored tamper-proof log. Finalized-hash conflicts stop ingestion;
there is no automatic evidence rewrite or reorg repair. The first scan still
starts at the existing bounded tail (up to 2,000 blocks), not full chain history.

Next: capture a bounded, read-only window of actual Arc testnet events, preserve
its provenance, replay it, and link that saved evidence to the investigation
workflow. Use those samples for independent review before making claims about
real incident coverage or agent effectiveness. Mainnet, real funds, 7b frozen
reruns, A402, payee cryptographic verification, database sharding and message
queues remain outside this version's scope.
