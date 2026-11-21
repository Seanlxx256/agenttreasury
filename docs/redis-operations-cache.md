# Redis operations cache

Redis is an optional, disposable cache for `GET /finance/operations/metrics`.
It stores the dashboard aggregate snapshot for at most five seconds. PostgreSQL
remains the source of truth. Cache entries cannot authorize a payment, release a
reservation, validate a grant, change a journal or approve a refund. Case details,
case transitions, payment evidence and all financial writes bypass this cache.
The [investigation recovery queue](investigation-recovery-dashboard.md) also reads
PostgreSQL directly so manual recovery is immediately reflected on refresh; its
summary is separate from the cached general operations metrics.

## Run locally

With Docker available, start only the cache from the repository directory:

```sh
docker compose up -d redis
export REDIS_URL=redis://127.0.0.1:6379
export REDIS_CACHE_NAMESPACE=finance-local
npm run finance:local
```

An existing Redis instance also works; Docker is not required by the application.
Set its connection URL in `REDIS_URL`. Use a different namespace for each database,
environment or restored copy, and the same namespace for API replicas sharing one
database. Never reuse a namespace across databases. Unset `REDIS_URL` to disable
caching. This change requires no database migration. Do not commit Redis credentials.

For the existing operations deployment, `compose.operations.yaml` starts Redis and
sets the API configuration. Workers and the signer do not depend on Redis. The
container has no published host port, caps Redis dataset memory at 64 MiB and uses
LRU eviction. No RDB snapshots or AOF persistence are enabled. The separate local
`compose.yaml` publishes Redis only on loopback. These are isolated development /
testnet configurations; shared infrastructure needs network isolation, Redis ACLs
and TLS (`rediss://`) as appropriate. The cache includes wallet addresses and worker
health, so it should not be exposed publicly.

## Behavior and limits

- Authorization runs before every cache access, including hits. Responses use
  `Cache-Control: no-store` to prevent browser/proxy caching of operator data.
- The existing SQL aggregate returns one PostgreSQL snapshot. The API adds `cache`
  metadata: `source`, `ageMs` and `ttlMs`. Sources are `redis`, `database`,
  `database-fallback`, or `disabled`. The console displays these and `observedAt`.
  Age is measured at response generation; the page does not continuously tick it.
- A hit may lag a case transition or worker update by up to five seconds. Detail
  views remain fresh. There is no synchronous write invalidation: the bounded lag
  is deliberate and no critical decision reads this endpoint.
- TTL is counted from before the SQL query. Expired, future-dated, malformed,
  incompatible or oversized entries are treated as misses. No expired fallback
  snapshot is served when PostgreSQL fails. Valid JSON also receives basic shape
  validation, not cryptographic authentication of dashboard data.
- Each Redis operation has a 150 ms total deadline, including connection setup.
  A miss can perform both a GET and a SET. A stalled socket is destroyed, offline
  command queuing is disabled, and failures trigger five seconds of backoff before
  another connection attempt. Database errors still fail the request.
- Concurrent metrics requests share one in-flight read per API process. Multiple
  API processes share Redis snapshots but may each refresh on a simultaneous miss;
  no distributed lock is used. Large-scale stampede/load testing remains future work.
- Shutdown destroys the cache connection. Losing Redis data requires no recovery
  procedure: the next successful read rebuilds it from PostgreSQL.

The client is the official [node-redis client](https://github.com/redis/node-redis).
Its [command timeouts](https://github.com/redis/node-redis/blob/master/docs/command-options.md)
cover queued commands; the adapter additionally bounds the entire operation so an
already-written command cannot wait indefinitely for a silent server.

## Verification

```sh
npm test
REDIS_TEST_URL=redis://127.0.0.1:6379 npm run test:redis
```

The second command requires a disposable loopback Redis. It creates temporary
PostgreSQL data and a local TCP proxy to simulate Redis network loss. Tests verify
shared-client hits, expiry, deletion, fresh database fallback, unchanged readiness
and reconnection after backoff. They use no wallet, RPC or payment-provider secrets.
CI runs both suites and an additional container smoke check that stops Redis while
leaving the API and PostgreSQL running.

The deterministic cache test performs 20 sequential reads within one TTL and checks
that only one aggregate query runs (19 avoided queries). This is query-count evidence,
not a claim of a 95% latency improvement or production throughput. Other console
queries, including case lists, still reach PostgreSQL.

Local verification on 2026-11-21 (Node.js 25.2.1, temporary Redis 7.4.2):

- Final `npm test`: 275 passed, zero failures/skips, about 33 seconds.
- `npm run test:redis`: two passed, including a real PostgreSQL/API network-fault
  and reconnect drill, about seven seconds. The temporary Redis was shut down.
- One earlier full run reported an audit-test child-process exit failure after all
  its assertions passed. Its standalone TAP rerun passed 5/5, and the subsequent
  full run passed 275/275 without an audit-code change; the cause is unconfirmed.
- Container startup/stop smoke is configured in CI but was not run locally because
  Docker is unavailable. These results establish behavior, not production load capacity.

## Historical evaluation reproducibility

Adding Redis changes `package-lock.json`. The original lock from commit `2d60a4b`
is preserved as `docs/evidence/pre-redis-package-lock.json`; its SHA-256 must match
the historical manifests. Existing source/compiled hashes and historical scores
are unchanged. Tests check that existing dependency versions, integrity and edges
are preserved (npm's peer-install bookkeeping may differ), then run historical
entrypoints in disposable directories with the archived lock. Runtime mismatch
checks remain active. Original frozen entrypoints correctly reject the current
lock instead of silently accepting a changed environment.

To rerun a historical frozen model experiment, use its original checkout, lock and
recorded runtime, or explicitly create a new evaluation protocol. Do not rewrite
old manifests to bless the new dependency environment. The Stage 16 acceptance
report remains historical; new test results do not overwrite it.
