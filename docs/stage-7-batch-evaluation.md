# Stage 7: frozen exploratory model comparison

The first fixed comparison does not demonstrate model value over rules for
this structured evidence-consistency task. Keep the deterministic backend
checks and current production defaults. This result is useful evidence about
this adapter and packet, not a production accuracy estimate or a general model
ranking.

## Protocol and provenance

The [protocol](../benchmarks/batch-investigation-eval-v1/protocol.json) and
[manifest](../benchmarks/batch-investigation-eval-v1/manifest.json) were frozen at
2026-11-16 19:03:34 UTC, before the measured model calls. The completed
[run report](evidence/stage-7-batch-investigation-models.json) is timestamped
2026-11-16 19:11:13 UTC (2026-11-17 in Asia/Shanghai).

The manifest binds 24 files covering the review data, protocol, lockfile, source
and compiled local dependency closure. It records Node v25.2.1, Ollama 0.40.16,
and full digests for the installed Q4_K_M Qwen 1.5B and 3.1B models. Settings were
temperature 0, seed 42, 512 output tokens and an 8192-token context. Each model
ran once over the same 12 cases, with 1.5B before 3B. No prompt or rule changes
were made after these outcomes were observed.

Internal review found the existing proposed labels consistent with their
inputs: one corroborated case, four incomplete cases and seven conflicts,
with 18 mandatory-check annotations and 21 annotated evidence paths. Labels
were not edited. Independent human adjudication remains pending. Ten cases
are synthetic variations of one payment, and the explanatory rule mapping
was written with knowledge of the cases. Neither the data nor the baseline
is independently held out.

## Measured results

| Method | Correct dispositions | Strict successes | Accepted outputs | False corroborations | Mean time per case |
| --- | --- | --- | --- | --- | --- |
| Rules | 12/12 | 12/12 | 12/12 | 0 | 0.46 ms |
| Qwen 1.5B | 4/12 | 1/12 | 11/12 | 1 | 6.18 s |
| Qwen 3B | 2/12 | 0/12 | 10/12 | 9 | 12.08 s |

Strict success requires the correct disposition, all annotated mandatory checks
and exactly the annotated path set. This is deliberately stricter than status
accuracy and can penalize reasonable alternative citations/checklists. It does
not measure semantic support independently of the annotations.

| Method | Mandatory-check recall | Annotated-path recall | Annotated-path precision |
| --- | --- | --- | --- |
| Rules | 100% | 100% | 100% |
| Qwen 1.5B | 22.2% | 14.3% | 3.7% |
| Qwen 3B | 33.3% | 28.6% | 7.5% |

The 1.5B run had one rejected output; 3B had two. There were no unavailable calls
and no missing usage records. Rejected outputs get no rule-fallback credit.
False corroboration counts include a parsed `corroborated` claim even if its
output is subsequently rejected: 3B had seven such accepted claims and two
rejected claims. These were offline advisory outputs, not approved payments.

Each model reported 42,094 input tokens. Output totals were 1,171 and 1,245,
respectively. The 24 calls took approximately 219 seconds in total, excluding
setup and metadata reads. Latency includes loading, inference, parsing and
validation; fixed run order and caching are confounders. This is not a cost
benchmark and no dollar cost or confidence interval is inferred.

## What the errors show

- **1.5B often repeats an authorization check regardless of the actual gap.**
  In case 03 it correctly says incomplete but asks to read authorization,
  missing that Gateway evidence was removed. It labels the normalized-delta
  contradiction a conflict in case 08, but points to unrelated authorization
  and journal fields rather than the raw batch mismatch.
- **3B often treats existing records as sufficient corroboration.** It marks
  missing original authorization (02), missing Gateway observations (03),
  wrong journal amount (04), wrong authorization recipient (06), conflicting
  Gateway states (10), inconsistent reservation state (11) and partial
  authorization (12) as corroborated. Missing original records cannot be
  repaired by copying other fields that happen to exist.
- **Schema validity does not imply a correct conclusion.** Most outputs passed
  the structural gate, yet many dispositions were wrong. The low path agreement
  is separate from this: not every non-annotated citation is a hallucination.
- **There is a conservative case worth retaining.** 1.5B handles the actual
  legacy missing-authorization case with the expected disposition, check and
  path. That one success does not offset its regressions elsewhere.

The saved report includes accepted decisions, scores, rejection/unavailability
statuses, parsed candidate statuses, durations and token counts. V1 does not
archive raw rejected response text or the exact validation subcondition that
failed. The two rejected 3B claims remain observable as corroboration attempts,
but their rejection cause should not be guessed from the report.

## Engineering changes and verification

The evaluation adapter sends only case evidence, the shared deterministic raw
batch validation result and permitted checks/citations to local Ollama. It does
not send labels, case IDs, mutation notes or rationales. It enforces the exact
schema, three unique read-only checks and eight unique existing citation paths.
Duplicate scoring cannot inflate coverage, and failures never inherit baseline
credit. Model/runtime/file mismatches stop a measured run before inference.

This is an evaluation adapter for post-collection dispositions and next reads;
it is not an end-to-end production agent trial, and it does not execute suggested
checks or modify payments, refunds, case state or budgets. No production routing,
model defaults or signer behavior was changed.

`npm test`: **203/203 passed**, no skips, approximately 29 seconds excluding
build. Six new tests cover the frozen dependency closure, schema and pointer
boundaries, deduplicated scoring, label isolation, failure handling and model
identity enforcement. The saved per-case outputs were also re-scored and their
aggregates matched the report. Actual inference ran separately from the full
test suite so database tests did not run concurrently with measured calls.

The application and ordinary CI remain Node 22-compatible. The frozen inference
command intentionally requires the captured Node v25.2.1 runtime. Unit tests
check pure rules/scoring and artifact hashes on other supported Node versions,
and verify that measured runs reject a runtime mismatch. This turn ran tests
locally on v25.2.1; Node 22 CI/container execution was not performed.

## Reproduce and improve

With the frozen runtime and installed model digests:

```sh
npm run eval:batch-investigation -- --rules-only
npm run eval:batch-investigation -- --models qwen2.5:1.5b,qwen2.5:3b
```

The [review packet](../benchmarks/batch-investigation-review-v1/README.md) still
needs independent review. Its immutable creation manifest's
`modelEvaluationRun: false` describes the earlier checkpoint; this separate
protocol and run report record the subsequent exploratory experiment.

Next development should separate evidence interpretation from hard consistency
checks, retain rejection diagnostics, and test a more compact evidence view on
new development cases. Review the labels and reasonable alternative citations
before defining a new evaluated version. Do not tune on these 12 cases and
present an improved score as blind validation. Agent contribution still needs
independent evidence; expanding financial decision authority is not justified
by this run. The agreed version exclusions remain unchanged.
