# Stage 3: bounded read-only investigation

Investigation suggestions now lead to actual evidence collection. An operator
starts a run; the backend captures the purchase's local records, selects a
bounded set of checks, validates citations, runs permitted reads and saves an
advisory report. Rules are the default planner. The model planner is optional
and experimental: the measured comparison below does not support replacing
the rules for this structured task.

## Execution boundary

1. Load selected records in one PostgreSQL `REPEATABLE READ READ ONLY`
   transaction. The collector also runs successfully under a SELECT-only role
   in the integration test, without access to agent credentials or signatures.
2. Build backend-owned facts and source references. Model interpretations from
   the triage subsystem do not become facts or tool authority. The planner sees
   normalized facts, not free-form instructions from provider errors.
3. Accept at most three distinct checks. Each needs 1–4 distinct fact citations
   relevant to that kind of read. Reject extra keys, arbitrary tool arguments,
   invented IDs, inference IDs, unrelated real IDs and duplicate checks.
4. Execute checks against the captured request. The model cannot supply a URL,
   SQL query, request ID, nonce, hash, recipient or network. Rejected/unavailable
   model output falls back to the rule plan.
5. Compare the selected local records again at completion. Save the original
   report and indicate if its local snapshot changed. Reading a saved report
   performs another freshness comparison without rewriting its evidence.

Citation validation establishes why a **read** is relevant. It does not prove
that the plan is optimal or that any root-cause diagnosis is true. The latest
model experiment demonstrates that a valid plan can still be a poor plan.

| Check | Evidence returned |
| --- | --- |
| Original authorization | Selected purchase fields, unsigned authorization, task budget and signing/submission timestamps. |
| Local journal | Original journal entry and debit/credit lines. |
| Refund status | Request, broadcast and recorded-refund states, including missing states. |
| Merchant recipient | Grant recipient/version versus current merchant recipient/version. |
| Compare transfer terms | Original terms, journal amount comparison, grant-version comparison and recorded Gateway observations. Missing raw Gateway fields are explicitly not a match. |
| Gateway status | Fresh pure transfer lookup by the stored nonce; no local accounting update. |
| Chain receipt | Receipt at a snapshot-bound hash on Arc testnet. A successful batch receipt alone is not individual-payment proof. |
| Batch calldata | Bounded raw transaction input at the same bound hash, with a truncation indicator; no inferred settlement claim. |

External checks require explicit operator opt-in and an Arc testnet purchase.
Their endpoints come from backend configuration. A missing bound transaction
hash blocks the chain read. External failures yield `unavailable`, never a
payment outcome. Each external check has a six-second wait bound; underlying
clients have their own timeouts. Three checks can involve more than three RPC
requests because a chain check also verifies the RPC chain ID.

There are no payment, signing, refund, budget-release, delivery-retrieval or
case-transition tools. The only write in this flow is an appended investigation
report. Existing **Check Gateway** accounting and financial actions remain
separate, explicit workflows.

## Evidence and freshness limits

Every report contains its selected original records, normalized facts, source
references, local fingerprint, plan/citations, tool outcomes and timestamps.
The collector retains the latest ten observations plus the latest decisive
observation so recent outages do not erase an older recorded conflict. It
sorts numeric observation IDs numerically. Provider reasons are bounded to
2,000 characters; signatures, retrieval tokens, credentials and delivery bodies
are not exported. The UI renders evidence as text.

Freshness covers those selected local fields, not the whole database or a
globally atomic view across Gateway and the chain. Remote reads have individual
observation times. A historical report can become stale immediately after a
check. The fingerprint is not an external audit anchor; the database remains
trusted. A fresh report never authorizes a financial action.

This is one bounded planning/execution round. It does not implement an
unrestricted autonomous loop, multi-provider search or model-generated final
root-cause verdict. The collector preloads local evidence, so fewer selected
checks do not imply fewer SQL queries or a measured infrastructure cost saving.

## Upgrade and use

Stop older application processes, apply all migrations through `036`, and
restart. Migration 036 only adds advisory run storage. Existing payments and
signatures are not rewritten.

```sh
npm run build
# DATABASE_URL must point to the intended test database.
npm run migrate
```

In the payment console, look up a Gateway purchase and select **Collect
investigation evidence**. Leave **Refresh Gateway and chain evidence** unchecked
for local-only reads. **View saved investigation** retrieves the latest report
and checks whether its selected local records have changed.

Both endpoints require a finance or operations token; agent tokens are denied:

- `POST /finance/gateway-purchases/:id/investigation` with
  `{"refreshExternal": false}` creates a run.
- `GET /finance/gateway-purchases/:id/investigation` retrieves the latest run.

Leave `GATEWAY_INVESTIGATION_MODEL` unset for the recommended rule planner.
Setting it to an installed Ollama model enables the experimental planner. It is
separate from `GATEWAY_TRIAGE_MODEL`. Model rejection/unavailability is visible
in the report, together with the effective fallback checks.

## Verification and actual model comparison

On 2026-11-17, `npm test` passed **163/163**, no skipped tests, with approximately
28 seconds of test execution excluding compilation. The new tests cover
SELECT-only collection, secret exclusion, numeric evidence ordering, older
decisive evidence, tool/citation bounds, opt-in and pinned external reads,
upstream failure, stale snapshots, operator permissions and unchanged business
tables. The UI test uses the repository's DOM harness, not a real-browser audit.

```sh
npm run test:investigation
npm run eval:gateway-investigation -- --rules-only
npm run eval:gateway-investigation -- --models qwen2.5:0.5b,qwen2.5:1.5b
```

The real local Ollama run used the existing eight-case
`gateway-investigation-v1` development dataset, containing 17 expected checks.
No labels were sent to the model. Models received normalized facts, the closed
tool set and permitted citation IDs. Output was subject to the new strict
runtime validator. The fixture labels are not independent holdout evidence.

| Planner | Accepted model plans | Model-only check recall | Model-only precision | Effective recall with rule fallback | Effective precision | Mean model request time |
| --- | --- | --- | --- | --- | --- | --- |
| Rules | N/A | N/A | N/A | 100% (17/17) | 100% (17/17) | N/A |
| Qwen2.5 0.5B | 2/8 | 11.8% (2/17) | 33.3% (2/6) | 88.2% (15/17) | 78.9% (15/19) | 864 ms |
| Qwen2.5 1.5B | 7/8 | 47.1% (8/17) | 38.1% (8/21) | 58.8% (10/17) | 43.5% (10/23) | 1,971 ms |

Model-only recall includes all expected checks across all cases and gives no
credit for rejected outputs. Effective metrics include rule fallback on rejected
or unavailable output. The scorer now deduplicates expected and suggested kinds
so repeated outputs cannot inflate recall. Request timing includes model API
latency; it is not human investigation time and is based on one local run per
model, not a latency benchmark. Validation/prompt changes mean these results
should not be directly compared with earlier investigation scores as if the
evaluation protocol were unchanged.

The [raw comparison report](evidence/stage-3-investigation-models.json) is checked
into the repository. No new model was downloaded, no paid API or chain request
was made for this evaluation, and no 7b frozen-set rerun was performed.

**Decision:** keep deterministic planning as the default. This milestone adds
safe evidence collection and more honest measurement, not demonstrated model
ROI. A model can pass citation checks and still omit important investigations;
fallback success must not be credited to the model.

Next: build independently labeled non-structured exception cases and evaluate
evidence extraction/coverage, unsupported claims, tool cost and investigation
time against a strong rule baseline. Do not tune against a frozen test split or
claim reduced human review without a corresponding study. Docker acceptance,
24-hour soak and OS-enforced signer separation remain pending from earlier
milestones; this work does not change the agreed version exclusions.
