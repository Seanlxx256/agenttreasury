# Stage 1: durable reconciliation operations

The balance scanner now creates stable operational cases above its original
discrepancy evidence. The console, metrics endpoint, workers and deployment
configuration make these cases inspectable and recoverable across restarts.
This milestone does not change payment authority or authorize new spending.

## Case identity and lifecycle

| Discrepancy | Identity within a network and payer | Behavior |
| --- | --- | --- |
| Unresolved authorization | Original request ID | Repeated scans append sightings to one case. |
| Batch mismatch / missing batch | Kind and normalized transaction hash | Repeated sightings stay together; different discrepancy kinds remain separate. |
| Balance difference | Historical block window | Different windows are separate investigations, even if the difference is equal. |

Original scan and discrepancy rows are retained. A case references its latest
evidence and has a version incremented for every new sighting and transition.
Replaying an identical discrepancy in the same scan creates no new occurrence.
Concurrent sightings serialize on the case, and evidence, case updates and the
scan cursor commit in one transaction.

Operators use `open -> investigating -> resolved`. A resolved case may be
manually reopened into investigating. Every transition requires a nonblank
outcome note, the exact displayed version and the latest discrepancy ID. Stale
versions or evidence return HTTP 409. Transitions are appended to the case
history and the existing tamper-evident audit chain in the same transaction.
The actor is the authenticated **role**, not an individually identified human;
SSO and per-person identity are not implemented by the shared-token console.

A new sighting with changed JSON evidence reopens a resolved case as open.
Identical later evidence stays attached without undoing the operator's closure.
This comparison is structural JSON equality, not semantic deduplication.
Disappearance from the next scan does not automatically close a case. Historical
scan status remains historical; resolving a case does not rewrite that report.

Case closure is an operational classification. It does **not** mark a payment
paid, release a reservation, alter a journal, approve a refund or fix a chain
balance. Payment conflicts remain governed by the separate payment review queue.
The LLM cannot perform these case transitions; only operations and finance
credentials are accepted.

## Upgrade

Stop old API and worker processes, back up the database, build, migrate and
restart together. Do not leave an older scanner writing ungrouped discrepancies.

```sh
npm run build
# Set DATABASE_URL to the intended local database, then:
npm run migrate
```

Migration `034` groups existing discrepancy records, preserves their original
status and evidence, and imports an event for each sighting. When historical
statuses disagree, unresolved work wins; the migration does not silently close
it. `/health/ready` now requires migration 034 instead of the obsolete 010 check.
The upgrade test constructs and populates a real 033 database before running
the normal migration runner twice.

## Operator API and console

Open `/finance/` with a finance or operations token. The new sections show
operations health, all/open/investigating/resolved cases, original scan evidence
and the latest 100 history events. Enter an investigation note before starting
or resolving a case. Refresh and review again after a version-conflict response.
All historical events remain in the database; the detail response is bounded.

| Endpoint | Behavior |
| --- | --- |
| `GET /finance/operations/metrics` | Authenticated operational snapshot. |
| `GET /finance/reconciliation-cases` | Unresolved cases by default; optional `status=all/open/investigating/resolved`. |
| `GET /finance/reconciliation-cases?before=<uuid>` | Next page, using the returned `next` cursor; at most 100 cases per page. |
| `GET /finance/reconciliation-cases/:id` | Version, latest evidence, occurrence count and recent events. |
| `POST /finance/reconciliation-cases/:id/transitions` | Role-authenticated versioned lifecycle transition. |

Transition body:

```json
{
  "expectedVersion": 3,
  "status": "resolved",
  "evidenceId": "00000000-0000-0000-0000-000000000001",
  "note": "Investigated the attached scan; recorded the outcome and follow-up."
}
```

Case pagination uses UUID keyset ordering, not severity or creation order.
A concurrent refresh is needed to see new cases that sort before the cursor.

## Metrics and logs

Metrics use one SQL statement so counts share a database snapshot:

- Case counts and age of the oldest unresolved case.
- Reserved purchases, due recovery work, paused reviews and oldest reservation.
- Latest unavailable/conflicting evidence for reserved purchases. These are
  unresolved evidence states, not irreversible payment failures.
- Failed scans, expired scan leases and total lease reclaims.
- Per-wallet last observed finalized height, cursor, lag and observation age.
  Lag is relative to that observed height, not an assertion about the live chain.
  A missing cursor yields null lag; an absent wallet/worker row means unobserved.
- Worker heartbeat, last success/failure, consecutive and total iteration errors.
  A successful iteration may still find unavailable upstream evidence; consult
  the separate evidence counts. Heartbeat age exposes a stopped process.

HTTP logs have server-generated request IDs, route, resource ID, status and
duration. Case transitions include case/version/evidence IDs. Gateway recovery
logs bind a run ID to the request ID; scanner logs bind a run ID to a scan ID and
window. Failure logs use error type without credentials or raw provider payloads.
Original diagnostic evidence remains in the protected database.

Suggested initial alerts: head/worker age above three polling intervals, any
expired scan lease, repeated worker errors, or an unresolved case exceeding the
team's review SLA. These are starting thresholds, not measured production SLOs.
There is no external metrics collector or paging service in this milestone.
Worker health currently describes one logical instance per worker type.

Run the scanner continuously with a public testnet payer address:

```sh
# DATABASE_URL and GATEWAY_SCAN_PAYER must already be set.
npm run worker:gateway-balances
```

The new runner permits Arc testnet only and polls every 30 seconds by default;
`GATEWAY_SCAN_INTERVAL_MS` permits 1–60 seconds. It requires no signing key.
The existing `scan:gateway-balances` command remains a single scan.

## Reproducible isolated deployment

`Dockerfile` builds the API and workers with Node 22. Its build context allowlist
excludes local environments, wallets, test artifacts and database directories.
`compose.operations.yaml` creates a separate PostgreSQL 18 volume, a migration
job, API and recovery worker. The API binds only to localhost on the host.
No private key is supplied, and the optional balance scanner is read-only.

Prepare a separate shell with these environment variables:

```sh
export OPS_DB_PASSWORD="$(openssl rand -hex 32)"
export FINANCE_APPROVAL_TOKEN="$(openssl rand -hex 32)"
export GATEWAY_OPERATIONS_TOKEN="$(openssl rand -hex 32)"
docker compose -f compose.operations.yaml up --build -d
curl --fail http://127.0.0.1:3000/health/ready
```

Keep the same database password for subsequent starts of that volume. Use a
secret manager or a local permission-restricted environment file outside Git
for persistent configuration. To scan an existing **testnet** wallet:

```sh
export GATEWAY_SCAN_PAYER=0xYourTestnetPayerAddress
docker compose -f compose.operations.yaml --profile balance-scan up --build -d
```

This is a reproducible single-database test deployment. It is not HA or a
hardened production deployment: the database owner is shared, role tokens are
shared, and secret rotation, external monitoring, TLS termination and hosted
backups remain deployment responsibilities.

## Backup and restart verification

Run the automated offline drill:

```sh
npm run test:operations
```

It creates temporary PostgreSQL databases and fixture evidence, tests upgrading
033 to 034, then seeds nonzero spent/reserved balances and a real local journal.
After a clean shutdown it copies the entire database directory, restarts the
source, starts the copy independently on another port and compares all rows in
the selected tables, including budgets, purchases, journal, cursors, original
evidence, cases, events and audit history. A write to the restored database must
not affect the original. No live API, private key or funds are used.

This is a **cold physical backup** drill of a single compatible PostgreSQL
installation. Never copy a live PGDATA directory. It does not validate online
backups, PITR, recovery from disk loss, multi-host restoration or a production
RTO/RPO. The fixture rows test persistence; existing scanner tests separately
verify failed-window recovery and expired-lease reclamation.

For the compose deployment, PostgreSQL's bundled tools support a separate
logical-backup workflow (not locally executed in this milestone):

```sh
# Choose a new filename; noclobber prevents accidental replacement.
(umask 077; set -C; docker compose -f compose.operations.yaml exec -T postgres \
  pg_dump -U agenttreasury -d agenttreasury -Fc > operations-backup.dump)
# Create a NEW restore database. Never use --clean against the source.
docker compose -f compose.operations.yaml exec -T postgres \
  createdb -U agenttreasury agenttreasury_restore
docker compose -f compose.operations.yaml exec -T postgres \
  pg_restore -U agenttreasury -d agenttreasury_restore --exit-on-error --single-transaction < operations-backup.dump
```

Do not use an archive from a failed dump. Keep archives permission-restricted
and outside Git. Validate restored balances, grants, journals and review queues
before pointing any application at a restore.

## Evidence and remaining acceptance

- Local verification (2026-11-16): TypeScript build and `npm test` passed
  **141/141**, with no skipped tests; test execution took approximately 24 seconds
  excluding the build. Coverage includes schema upgrade, concurrency, version
  conflicts, restart and cold restore.
- Console verification: real handlers exercised through the existing DOM
  harness; not a browser layout/accessibility certification.
- CI definition: fresh dependency install, full tests, image build and isolated
  compose API readiness check. Adding this workflow is not evidence of a green
  GitHub Actions run.
- Docker image/compose startup: pending an actual Docker-capable run; Docker is
  unavailable on the development host used for this milestone.
- A 24-hour soak is **not performed or claimed**. A deployment soak should retain
  logs and metrics through scheduled API/worker restarts, upstream outages and
  a restored database check. Short automated drills do not replace that evidence.

The next engineering milestone is signer isolation and constrained signing
requests. Mainnet, real money, frozen-set 7b reruns, A402, payee cryptographic
verification, database splitting and message queues remain outside this version.
