# Distributed, multi-network, multi-merchant design

This document records how AgentTreasury moves past the single-merchant,
single-process, single-network prototype while staying honest about what is and
is not production-ready. The throughline is the same as the rest of the repo:
the system keeps its failure-state guarantees (idempotency, at-most-once
settlement, dual-ledger reconciliation) as it gains concurrency and network
breadth.

## 1. Network is data, not process configuration

Before: `GATEWAY_NETWORK` selected one network and `gateway-x402.ts` exported
module-level singletons (`arcGatewayNetwork`, `gatewayApi`, `gatewayDomain`).
Every downstream module imported that singleton, so one process could only ever
touch one network.

Now: `gatewayNetworkConfig(network)` is a factory that derives every
network-specific value — chain, RPC, USDC address, Gateway contract, CCTP
domain id, REST API, and the Circle CLI name — from Circle's official
`CHAIN_CONFIGS`. Each purchase stores its own `network` column
(`db/020_gateway_purchase_network.sql`), so a single reconciliation pass or
worker pool can span testnet and mainnet without a restart per network.

The old singleton exports remain as the process default for backward
compatibility; multi-network call paths pass `network` explicitly. This keeps
the change small at each call site while making the network a first-class
dimension of the data model.

## 2. Concurrent workers: claim + lease, never double-handle

The Gateway reconciliation worker already relied on two PostgreSQL primitives
that are the correct foundation for multi-process safety:

- **`FOR UPDATE SKIP LOCKED`** in the claim query: several worker processes
  race for due purchases; each row is locked by exactly one claimant and the
  others skip it.
- **A `reconcile_after` lease**: a claimant bumps the row's next-eligible time
  before doing work, so a crashed worker's row becomes eligible again rather
  than being re-handled by a peer immediately.

`db.ts` also exposes `pg_advisory_xact_lock` for cross-process idempotency of a
single incoming transfer. The test suite proves the property directly: several
concurrent worker invocations over several due purchases settle each purchase
exactly once, with one Gateway lookup and one journal line per purchase.

The important, deliberate constraint: **this concurrency model is PostgreSQL
shared-state concurrency.** It is horizontal across processes only as long as
they share one database. That is the right first step for a payments system —
the database is the source of truth, and correctness comes from row locks and
leases rather than from an external lock service — but it is not a sharded or
multi-region story yet.

## 3. Merchant is a first-class entity

Before: a single `GATEWAY_MERCHANT_RECIPIENT` environment variable, and the
recipient address was scattered across `gateway_task_grants` and
`gateway_demo_purchases` with no merchant identity.

Now: `gateway_merchants` (`db/021_gateway_merchants.sql`) is a table keyed on
`(recipient, network)` — one merchant, one payout address per network — and
both the task grant and the purchase reference it through `merchant_id`. A
single deployment can therefore settle for several merchants, each pinned to
its own network and payout address, and reconciliation is naturally partitioned
by merchant.

A payout-address change never moves the live address in one step: it is staged
via `POST /finance/merchants/:id/recipient-change`, then confirmed by a finance
operator via `POST /finance/merchants/:id/recipient-change/confirm`. Both steps
write an audit row (`requested` by the operator role, `confirmed` by
`finance-operator`), so the B2B "change the bank account" substitution vector is
blocked at the console boundary rather than only inside a helper function.

## 4. Continuous balance scanning with a persisted cursor

Balance reconciliation was a one-shot CLI (`reconcile-gateway-balances.ts`)
that printed a JSON report and exited: no memory of what it had scanned, no
automatic work order for a discrepancy, and no recovery if the process died
mid-scan. `gateway-balance-scanner.ts` + `db/028_balance_scan.sql` make the same
reconciliation a repeatable, recoverable, auditable pass:

- **A persisted cursor** (`gateway_balance_cursors`, keyed on `(network, payer)`)
  records the next block to scan. Each run advances it only after the window's
  result is durably written, so a crash never skips or double-counts a block.
- **A leased, unique scan record** (`gateway_balance_scans`, unique on
  `(network, payer, from_block, to_block)`) makes a window idempotent: re-running
  the same window returns the existing result instead of reconciling again. A
  `running` row whose lease expired is claimed again, which is the crash-recovery
  path.
- **Work orders** (`gateway_balance_discrepancies`) are raised automatically for
  each class of difference the report can produce — balance, batch, missing
  batch, unresolved authorization — with `open` / `acknowledged` / `resolved`
  state and a unique `(scan_id, kind, detail)` key so re-scans do not duplicate
  them.
- **Metrics** (`gatewayBalanceScanMetrics`) expose the latest scan window and
  the open work orders by kind, which is the alerting surface a scheduler can
  poll.

The recovery drill is a test, not a story: a `running` scan row whose lease is
in the past is re-claimed and completed, and re-running an already-scanned
window adds no duplicate work orders.

## 5. Where the boundary still is

This work closes the single-merchant/single-network gap and makes the existing
concurrency primitives explicit. It does **not** yet provide:

- **Multiple Postgres instances / sharding.** `SKIP LOCKED` and advisory locks
  are correct within one database. Scaling past one writer requires partitioning
  by merchant or by network, or a move to an outbox/queue with exactly-once
  delivery.
- **A message queue.** The workers poll the database on a cadence. That is
  simple and correct, but high throughput or bursty load would push toward a
  queue (or `LISTEN/NOTIFY`) for lower latency and better backpressure.
- **Real mainnet settlement.** The code is mainnet-ready (`gatewayNetworkConfig`
  resolves the mainnet chain, RPC, contract, and API), but validation stays on
  testnet by policy — no real funds.

These three are the next production milestones, in that order.
