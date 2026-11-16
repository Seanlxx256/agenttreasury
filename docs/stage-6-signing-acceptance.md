# Stage 6: complete modern signing acceptance and review packet

Follow-up: [Stage 7 exploratory comparison](stage-7-batch-evaluation.md) evaluates
the review packet under a separately frozen protocol. The evidence and claims
below describe the Stage 6 checkpoint.


A new Arc testnet order has exercised the separate signer, actual buyer
executable, project-operated merchant, Gateway acceptance, batch settlement,
local journal and offline evidence replay. This closes the missing original
authorization acceptance for the modern path; it does not alter or retrofit
the earlier legacy evidence.

## Observed results

The complete artifact is [stage-6-modern-signing.json](evidence/stage-6-modern-signing.json).

| Item | Observed result |
| --- | --- |
| Request ID | `e9c47400-1789-4a3d-bbf3-e7d4ef8f5812` |
| Network | Arc testnet, chain ID 5042002 |
| Budget and actual spend | 1000 USDC base units = 0.001 test USDC |
| Signer | Separate `gateway-signer-server.js` process using the existing local test key |
| Signature issued | 2026-11-16 18:34:28.853 UTC |
| Submission recorded | 2026-11-16 18:34:28.884 UTC |
| First check observing charged | 2026-11-16 18:36:43.117 UTC |
| Captured batch block | 72586717 |
| Batch transaction | `0x0be2e77561ba007ef136699627523756d19a55cd4f98559d3c30093b831a8b57` |
| Gateway balance | 498000 to 497000 base units |
| Chain / journal difference | 0 / 0 |
| Signature rows / journal rows | 1 / 1 |
| Reserved / spent | 0 / 1000 |
| Delivery | Buyer and seller saved; commitment satisfied |
| Field linkage | corroborated |

The first charged observation was about 2 minutes 14 seconds after submission;
this is an observation interval, not a precise settlement latency or SLA.
Initially the service was delivered while Gateway remained pending, with the
full budget still reserved. The same nonce was subsequently reconciled and
posted once. Re-running `purchase` at 18:48:27 UTC retained the original request,
authorization hash, signature issuance time, one signature, one journal and
1000 units of total spend. See [resume check](evidence/stage-6-resume-check.json).

The merchant and delivered trace are project-operated fixtures. Real testnet
USDC authorization and Gateway settlement were used, but this is not evidence
of a third-party paid trace provider's quality or production acceptance.

## Execution and safety boundaries

The harness uses an isolated `.gateway-acceptance/` database and one durable
request ID. Its task budget, daily budget and signer per-payment cap are 1000
units. An existing request takes the check path on rerun; the harness does not
start another buyer or signer for it. Unknown payment status is retained under
the same ID. Do not delete the manifest to bypass an uncertain request.

The parent passes a key-file path to the signer child and never reads the key
bytes. The buyer receives the existing narrow environment allowlist, without a
private key or key-file path. Credentials, signatures and database files remain
in ignored local storage. Existing Gateway and finance stores were not migrated
or replaced. No mainnet funds, deposit, refund or second payment were involved.

Local audit verifies the stored authorization hash and recovers the payer from
its signature. Public artifacts include only authorization fields, the hash
and verification results; the bearer signature is omitted. Offline replay
recomputes the authorization hash, timing consistency, budget/count/delivery
conditions and batch linkage. It cannot independently repeat signature recovery
without the omitted signature. Neither result proves per-nonce inclusion in
net batch calldata or payee entitlement, and neither authorizes a new payment.

The first export revealed a real bug in the common evidence digest: JavaScript
Date objects were hashed differently from their serialized JSON representation.
The digest now normalizes JSON semantics before canonical key sorting, including
Dates, omitted undefined object fields and null array entries. Existing JSON-only
artifacts retain their hashes. The harness now validates the serialized artifact
before writing it; the invalid initial export is retained only in ignored local
storage, and the committed capture passes offline replay.

## Reproduction

Offline verification requires no wallet, database or network:

```sh
npm run build
npm run verify:gateway-signing -- docs/evidence/stage-6-modern-signing.json
```

The live harness uses the previously configured local test key and payer/payee
from the verified legacy project artifact. These commands can create a single
test payment on first use; `check` and `capture` never submit payments:

```sh
npm run acceptance:gateway-signing -- purchase
npm run acceptance:gateway-signing -- check
npm run acceptance:gateway-signing -- capture /tmp/modern-signing-acceptance.json
```

The script pins Arc testnet and the official Gateway API, refuses external
signer/API overrides, migrates only its isolated database, uses exclusive output
creation and shuts down its local services after each invocation. A missing
manifest is an error for `check` and `capture`. This is a local acceptance
harness, not OS-level key isolation, KMS/HSM custody or a production deployment.

## Investigation review material

[batch-investigation-review-v1](../benchmarks/batch-investigation-review-v1/README.md)
contains 12 versioned inputs: two captured cases (modern complete linkage and
legacy missing authorization) and ten labeled synthetic variations covering
missing Gateway evidence, wrong amount/nonce/payee/batch reference, inconsistent
raw calldata, missing raw evidence, conflicting Gateway states, reservation
mismatch and partial authorization. Synthetic cases are not real incidents.

Input, proposed labels, provenance and source archives are hash-bound. A blind
review export contains inputs and blank annotations, excluding the proposed
answers and mutation descriptions:

```sh
node scripts/export-batch-investigation-review.mjs > /tmp/batch-review.json
```

Labels currently have one author; independent human review is pending. This is
a review packet, not a blind benchmark. No model comparison, improved accuracy,
reduced manual review or operator-time saving is claimed. The repeated synthetic
variants are correlated and cannot be treated as independent incident samples.

## Validation and next step

`npm test`: **197/197 passed**, no skips, approximately 29 seconds excluding
build. Added coverage validates local signature recovery without exporting
credentials, corrupt and malformed signing evidence, the real modern capture,
rehashed-but-inconsistent acceptance reports, JSON digest round trips, review
packet provenance/hashes and answer-free reviewer export. The existing old
benchmark freeze still passes.

Next: review the proposed case labels, preregister citation and disposition
scoring, freeze evaluation runtime/model settings, then compare rules and agent
outputs on that protocol. Production deployment/soak and independent operator
outcomes remain unverified. Mainnet, real money, 7b frozen reruns, A402, payee
cryptographic verification, sharding and message queues remain excluded.
