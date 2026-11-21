# Frozen reviewed-claim comparison

The executor is implemented; the 48-case review corpus remains unreviewed and
unevaluated. No real completed review, frozen labels, execution plan or evaluation
report has been added. The engine tests use two separate synthetic cases and mocked
model responses. They demonstrate runner behavior, not AI quality.

## Review, plan, then run

Follow the [review handoff](../benchmarks/claim-review-v1/README.md) first. Retain
the original completed review file exactly as frozen. Only complete reviews
declaring an external reviewer, no model assistance and no exposure to author
labels/model outputs pass the freeze gate. Verify those declarations outside the
tool; the software cannot authenticate a reviewer or enforce blindness.

After an actual review and label freeze, run from the repository root:

```sh
# Replace the model name with an already installed Ollama model.
# This contacts localhost for model metadata but performs no inference.
npm run eval:frozen-claims -- --plan --model YOUR_INSTALLED_MODEL \
  --labels /tmp/claim-labels-frozen.json --review /tmp/reviewer-a.json \
  --output /tmp/claim-plan.json

# Inspect and retain the plan before starting. This performs inference.
npm run eval:frozen-claims -- --run /tmp/claim-plan.json \
  --labels /tmp/claim-labels-frozen.json --review /tmp/reviewer-a.json \
  --output /tmp/claim-comparison.json
```

The executor uses the existing adapters and local Ollama endpoint; it does not
download models or read wallet credentials. A run uses all frozen cases, with one
attempt per case in each arm: contextual rules, the legacy adapter and the
structured adapter. Rules run first; the two model arms alternate order by case.
There is no retry, subset selection, automatic resume or CLI fixture bypass.

## What is pinned and checked

The plan records the exact original review and frozen-label file hashes, corpus
and annotation hashes, complete case order, prompts, generation options, scoring
contract, model digest, Ollama version, Node version, OS and architecture. It hashes
the evaluator's static relative-import source/compiled dependency closure,
package lock and corpus files. Exporting the existing prompt/options constants
did not change either production adapter's request values.

Before and after every arm, the runner rechecks the plan, original review, frozen
labels, files and runtime metadata. Drift stops the run. Labels must match a fresh
validation of the original review; editing a frozen artifact cannot bypass it.
Original review whitespace changes also invalidate its byte hash.

These checks detect recorded configuration changes, not hostile local tampering.
They are not signatures, a hermetic build, proof that loaded code matches disk,
or attestation of the running inference server. GPU/backend configuration,
system load and model nondeterminism are not fully controlled by the plan.
Source statements alone reach inference; reviewer labels and rationale remain in
the scorer and local report. Treat the plan/report as label-bearing artifacts,
not blank reviewer handoffs.

## Metrics and attribution

| Metric | Meaning |
| --- | --- |
| Exact active topics | Exact source/topic set for reviewer-labelled current or uncertain claims |
| Supported exact | Exact topics plus source-bound quotes containing a labelled supporting span for that same source/topic |
| TP, FP, FN and unsupported quotes | Deduplicated correct, extra and missing active topics; unsupported quote candidates counted separately |
| Assertion states | Structured adapter only: exact source/topic/state sets, separately checking quote support |
| Raw model materials | Structured adapter's supplied-material coverage, misses and unsupported candidates |
| Deterministic materials | Shared parser measured separately; never attributed to model improvement |
| Workflow holds and fallback | Same contextual gate across arms; held matching answers do not count as success without review |
| Status and latency | All attempts, including rejection/unavailability; per-arm elapsed time with total, P50 and P95 |
| Token usage | Provider-reported input/output counts and explicit counts of attempts with missing usage |

Model rejection/unavailability earns no model exact/support credit, including on
empty-label cases. A rule fallback remains visible in the workflow result but
does not inflate model accuracy. The summary includes paired improvements and
regressions against rules and descriptive Wilson 95% intervals. Quote matching
checks annotated spans, not independent semantic truth. Synthetic cases may be
correlated, so the intervals do not establish production confidence.

Latency covers extraction, context checks and scoring, including a failed model
call's elapsed time. It excludes metadata/hash guards and file synchronization;
it is neither total CLI wall time nor human review time. First-call loading and
runtime caching can influence the model comparisons. Missing token usage is not
evidence of zero cost. Raw model state/material scoring is diagnostic; it does not
replace the production material checklist or authorize any action.

## Durable outputs and interruptions

Outputs are created exclusively; existing paths are never overwritten:

- `claim-comparison.json.plan.json`: the plan snapshot and its hash binding.
- `claim-comparison.json.cases.jsonl`: a started event and each arm as it completes,
  synchronized to disk before proceeding.
- `claim-comparison.json`: the completed report, written only after all cases,
  guards and journal consistency checks pass.

The final path is reserved before inference and stays empty if execution stops
before report writing. A caught failure appends an `aborted` journal event; abrupt
termination may leave only the last complete events or a partial trailing write.
A crash during final writing can leave an incomplete JSON file. Neither an empty
file, a truncated file nor a partial journal is a completed result. Preserve the
files and the command's error/exit status when investigating interruptions.

The runner does not silently resume, omit failed attempts or merge partial runs.
An explicit rerun needs a new output path and must be disclosed; after viewing
results, that corpus is no longer an unseen test set for further tuning.

All reports retain `independentReview: false`, `blindingVerified: false`,
`promotionEligible: false` and `financialAuthority: false`. This evaluation alone
cannot prove reduced manual workload, human time savings, business ROI or readiness
to promote the model to a production default.

## Validation and next step

Ten targeted tests cover scoring and failure denominators, state/material
attribution, input isolation, execution order, complete journal capture, output
collisions, interrupted runs, journal/final consistency, bounded model metadata,
label provenance, plan/runtime drift and CLI gate enforcement. Planning fixtures
use temporary fabricated declarations solely to exercise validation; the 48
corpus inputs are never classified or material-parsed in these tests.

Verification on 2026-11-21: TypeScript build passed, targeted tests passed 10/10,
and the full regression suite passed 308/308 with no failures or skips (about
33.0 seconds excluding build). `git diff --check` passed. No live model inference
on the review corpus or payment operation was performed for this milestone.

Next: obtain the actual external review, examine disagreements and freeze the
chosen annotations. Then pin the installed model and run this comparison before
making further prompt/parser changes based on those results. A controlled human
study is a separate requirement for any operator-efficiency claim.
