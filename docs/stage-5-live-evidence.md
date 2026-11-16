# Stage 5 follow-up: live testnet sample and investigation references

Subsequent acceptance: [real batches and project purchase linkage](stage-5-batch-acceptance.md).
The deposit-only limits below describe this earlier checkpoint.

This step adds an actual public Arc testnet deposit capture, tests persistence
and replay of that capture in PostgreSQL, and connects saved wallet reconciliation
evidence to the bounded, read-only investigation workflow. These are distinct
acceptance paths: the public sample has no local purchase or journal, while
request-bound investigation behavior is tested with synthetic local records.

## Observed live evidence

The committed artifact is [stage-5-live-balance.json](evidence/stage-5-live-balance.json).
It was captured at `2026-11-16T17:37:39.273Z` (2026-11-17 in Asia/Shanghai) from
the configured public Arc testnet RPC, chain ID `5042002`:

| Field | Observed value |
| --- | --- |
| Finalized height at capture | 72581684 |
| Captured window | 72581534 only |
| Event | One `Deposited` event, log index 64 |
| Transaction hash | `0x61d3b6d60186b17b6e8aed097ff320ac87d103d298948fe4d6fcf0dc60002a55` |
| Deposit amount | 1101000 USDC base units |
| Opening Gateway balance | 1000005300991732 base units |
| Closing Gateway balance | 1000005302092732 base units |
| Recomputed chain difference | 0 |
| Snapshot SHA-256 | `4e994cb73b69c245c19b43a83c64b013fd9442c89f94d96f8d5714a4c92ebd35` |

The payer was discovered from public deposit logs; it is not claimed to be a
project-controlled wallet. The tool did not load `.env`, private keys, wallet
files or an operational database, and did not send any transaction. Discovery
is capped at 2,000 finalized blocks. The first attempt hit RPC HTTP 429; a second
attempt with pacing and bounded retries succeeded. This is not sustained-load
or provider-availability evidence.

The artifact has `scope: public-chain-only` and `ledgerScope: none`. Its
`MATCHED` result means the supplied chain movements explain the observed balance
change. An empty local journal cannot establish reconciliation of a real
business ledger. It is not an incident, an individual payment proof or a model
evaluation case. No live batch, withdrawal, burn or refund was captured here.

## Reproduce without a network

```sh
npm run build
npm run capture:gateway-balances -- --replay docs/evidence/stage-5-live-balance.json
```

The file replay uses no database or network. It returns `verified: true` and
`ledgerScope: none`. Tests independently decode the saved deposit's ABI topics
and data, check its payer/token/value, persist it idempotently in an isolated
PostgreSQL database, and reproduce the report through database replay.

To capture a new public sample without overwriting the committed evidence:

```sh
npm run capture:gateway-balances -- --discover /tmp/arc-deposit-sample.json
npm run capture:gateway-balances -- <payer> <from-block> <to-block> /tmp/arc-window-sample.json
```

Both capture modes are fixed to Arc testnet. Explicit windows retain the
existing 2,000-block bound. Output creation uses `wx` so existing artifacts
cannot be silently replaced. The snapshot records an RPC endpoint fingerprint,
not the endpoint URL or credentials. As with Stage 5, single-provider evidence
is not an independent proof of log completeness.

## Investigation integration

`read-balance-evidence` is a new permitted read. The backend selects at most
three recent saved scans matching the original request ID, nonce, network and
payer. A wallet-only match is insufficient. Models cannot choose a scan ID,
URL, nonce or another request. The selection is part of the existing repeatable
read, read-only snapshot and uses the same three-tool maximum.

The collector rechecks the evidence digest and recomputed report before exposing
a summary. It includes scan IDs, digests, capture times, window boundaries,
wallet-level differences and relevant batch/event references. Other request IDs,
raw batch calldata and the full wallet purchase list are omitted. Chain-only
samples cannot support a purchase investigation. Corrupted linked evidence
produces an unavailable check, not a balance or settlement conclusion.

Saved evidence participates in the investigation fingerprint: a newly linked
snapshot or failed replay invalidates previous freshness. The existing
`POST /finance/gateway-purchases/:id/investigation` response and saved report
contain these checks. Authorization, advisory-only execution and no automatic
payment/refund/case-closure boundaries remain unchanged. No model ROI claim or
new model score is made by adding this deterministic read.

Apply migration `038` using the normal migration runner. It indexes the purchase
bindings inside snapshots without indexing bulky event logs. No new data table
or background worker is required. A SELECT-only investigation role also needs
SELECT on `gateway_balance_evidence` and `gateway_balance_scans`.

## Validation and remaining work

Local full suite: **183/183 passed**, no skips, approximately 28 seconds excluding
build. New checks cover actual sample decoding/persistence/replay, checksummed
SDK contract addresses in direct batch validation, conflicting duplicate RPC
logs, request/nonce isolation, evidence limits and freshness, corruption and
chain-only rejection. The SDK address normalization fix prevents a checksummed
contract address from falsely rejecting a valid batch whose destination was
lowercased before comparison.

The user's running database was not migrated or populated with this public
sample. Database acceptance used temporary PostgreSQL instances. No live
purchase-to-batch investigation, production incident, independent label review,
container soak or operator-time measurement was performed. Next, collect real
batch settlement evidence read-only and validate its relationship with local
authorizations and journal entries before evaluating investigations on those
records. The agreed version exclusions remain unchanged.
