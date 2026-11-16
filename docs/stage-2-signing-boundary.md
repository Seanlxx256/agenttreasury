# Stage 2: constrained Gateway signing service

The executable Gateway buyer no longer reads a private key or invokes Circle
CLI signing. It calls a separate signer process with a request ID and task ID.
The signer reconstructs an already-reserved authorization from PostgreSQL,
checks its authority and returns a signature for that exact authorization.
This milestone covers the **Arc testnet buyer**. Merchant refund signing and
Base Sepolia signing are separate paths and have not been migrated here.

## Authority and policy

`POST /sign-gateway-request` requires two credentials: a backend service bearer
token and the task owner's `x-agent-token`. The body accepts only:

```json
{
  "requestId": "00000000-0000-0000-0000-000000000001",
  "taskId": "00000000-0000-0000-0000-000000000002"
}
```

Extra fields such as domain, nonce, recipient, amount or typed data are rejected.
The signer independently checks:

- Current agent/task enablement, expiry and ownership.
- Exact service endpoint, network, payer and recipient grant.
- The merchant's current approved recipient version.
- A reserved, not-yet-submitted purchase and consistent task/day budget counters.
- Arc testnet only; the key's payer address; a signer-configured recipient
  allowlist and per-authorization maximum amount. The current trace price must
  also match; this is not a generic arbitrary-amount transfer API.
- Persisted nonce, payer, recipient, amount and validity window. The domain and
  EIP-712 types come from the fixed local Gateway configuration, never the caller.

Grant and budget checks run under database locks before issuance begins and
again before a new signature is persisted/returned. Cached signatures require
fresh authority checks too. A signature is verified against the configured
payer before it can be returned.

## The failure boundary

Migration `035` adds the original `signing_authorization`, `signing_started_at`
and a request-keyed `gateway_signatures` record with the EIP-712 hash. Before
private-key use, a transaction commits the signing marker and an audit event.
This is the conservative boundary at which signature exposure becomes possible.

| Failure | Behavior |
| --- | --- |
| Rejected before signing starts | Existing unsigned cleanup may release the reservation. |
| Signer crashes or throws after the durable marker | Keep the original nonce, authorization and reservation. |
| Signature was issued but its HTTP response was lost | Keep the reservation; do not replace the request or authorize another payment. |
| Exact signer retry before merchant submission | Recheck authority and return the cached signature, or sign the identical persisted authorization if the previous attempt never saved it. |
| Grant revoked while signing | The second authority check rejects the response; uncertain funds remain reserved. |
| Recovery sees no transfer | Unknown remains unknown; the worker does not expire a signing-started reservation. |
| A matching charge is later confirmed | Reconcile the same nonce and post the existing payment journal once. |

Concurrent signer retries may compute the same authorization's signature more
than once; the cached result and authorization identity are single-record. The
guarantee is not “one cryptographic operation.” No new nonce or validity window
is created by retrying the signer. The buyer's existing-row path remains
read-only recovery and does not replay a paid POST.

Once signing starts, a database trigger rejects changes to payment terms,
authorization, accounting ownership or the signing marker, and rejects deletion
of that purchase. Budget status and delivery can still advance through existing
reconciliation paths. Old purchases without a stored validity window remain
reconcilable but cannot be signed by inventing a new window.

The worker, balance reconciler and terminal-payment accounting now include
signing-started purchases even if merchant submission was never recorded.
The console shows the signing timestamp. A signing marker means **possible
exposure**, not proof of merchant submission or payment acceptance.

## Running locally

Apply current migrations before starting any buyer, API, worker or signer:

```sh
npm run build
# DATABASE_URL must point to the intended test database.
npm run migrate
```

For the embedded database launcher, keep the existing public payer/recipient
configuration and set the key path for the launcher:

```sh
export GATEWAY_SIGNER_KEY_FILE=.gateway-local/payer-key
npm run gateway:local -- buy
```

That command retains its existing behavior of making one testnet purchase. The
launcher now starts a signer child on a random loopback port and stops it before
shutting down the database. It passes only an allowlisted environment to the
buyer: no signer key path, merchant key or unrelated secret. The legacy
`GATEWAY_TESTNET_SIGNER_FILE` is accepted by the launcher as a path alias, not by
the buyer. An externally configured `GATEWAY_SIGNER_URL` and token bypass local
signer startup.

For a separately running PostgreSQL database, start the signer in its own shell:

```sh
# DATABASE_URL is already configured for this test database.
export GATEWAY_NETWORK=arcTestnet
export GATEWAY_SIGNER_KEY_FILE=/absolute/path/to/testnet-payer-key
export GATEWAY_SIGNER_RECIPIENTS=0xYourApprovedTestnetRecipient
export GATEWAY_SIGNER_MAX_AMOUNT_UNITS=1000
export GATEWAY_SIGNER_TOKEN="$(openssl rand -hex 32)"
npm run signer:gateway
```

Use a permission-restricted key file (0600 or 0400). The signer rejects group or
world-readable files. Its default address is `127.0.0.1:3004`; override the port
with `GATEWAY_SIGNER_PORT`. Never paste key bytes into a command or commit them.
Transfer the service token through your local secret configuration to the buyer
shell; do not expose it in URLs or logs.

The buyer shell requires the existing task credentials and public addresses,
plus the service endpoint/token, and must have no signer key path configured:

```sh
unset GATEWAY_SIGNER_KEY_FILE GATEWAY_TESTNET_SIGNER_FILE
export GATEWAY_SIGNER_URL=http://127.0.0.1:3004
# Set GATEWAY_SIGNER_TOKEN to the same secret configured for the signer.
npm run buy:gateway -- "$REQUEST_ID"
```

The client permits HTTP only on loopback, requires HTTPS for remote URLs,
rejects embedded URL credentials, disables redirects and bounds request time.
The standalone server binds loopback; a remote deployment needs an authenticated
TLS proxy. The old in-buyer Circle CLI fallback has intentionally been removed.
Replacing key custody with a provider adapter is separate work.

## Security claims and limits

- **Implemented:** separate process, identifier-only request schema, two
  credentials, independent signing policy checks, durable issuance intent,
  exact-authorization cache, grant rechecks and secret-free operational logs.
- **Not an OS sandbox:** two processes running as the same operating-system
  user can generally read each other's accessible files. The local launcher
  proves a process/API boundary and prevents accidental key inheritance. Use
  distinct service users/containers and mount the key only into the signer for
  filesystem isolation; that deployment has not been accepted here.
- **Trusted backend/database:** the buyer and signer currently use the same
  authoritative database. Shared DB-owner credentials cannot defend against a
  malicious administrator rewriting grants, budgets or disabling triggers.
  The independent signer cap/recipient list narrows authority but is not a
  substitute for database privileges or a wallet-native daily spending policy.
- **Revocation timing:** application revocation cannot cryptographically revoke
  a signature already issued. The Gateway validity window remains approximately
  seven days for compatibility with the existing testnet flow. A crash can keep
  a budget reserved until authoritative recovery or review; a missing lookup
  alone never authorizes release.
- **Key custody:** this adapter uses a local EOA file in the signer process. It
  is not KMS/HSM/MPC, a Circle Agent Wallet policy integration or mainnet proof.
  Stored signatures and database backups should be treated as sensitive bearer
  authorization material. Console endpoints do not return signatures.
- **Test injection:** `purchaseGatewayTrace` still accepts a signing function
  for fixture tests and the offline simulator. Those local test adapters are
  not evidence of production key isolation. The executable buyer uses the
  constrained service client.

## Verification

```sh
npm run test:signer
npm test
```

Local verification on 2026-11-17: `npm test` passed **151/151**, with zero
skipped tests and approximately 26 seconds of test execution excluding build.
The full suite includes the signer cases and all previous regressions.

Tests use random throwaway keys, temporary PostgreSQL and loopback services.
They verify denied raw payloads and unauthorized callers, wrong chain/payer/
recipient/amount/window, concurrent retries, cached-signature revocation,
grant revocation during signing, failed signing, lost signer HTTP responses,
budget retention and later charge reconciliation. One test starts the actual
signer executable, signs over HTTP, kills it with SIGKILL, restarts it and
retrieves the persisted signature. Another checks the launcher's buyer
environment allowlist. No faucet, chain submission or real funds are involved.

The previously recorded live Arc testnet payments predate this signer service;
they do not validate this new deployment path. Docker/CI execution, a 24-hour
soak and OS-enforced key separation remain unverified. Mainnet, real money,
frozen-set 7b reruns, A402, payee cryptographic verification, database splitting
and message queues remain outside this version.

Next: extend the read-only operations agent's investigation support and measure
it against the rules on independent cases, while preserving these execution
boundaries. Container/soak acceptance can proceed when Docker is available.
