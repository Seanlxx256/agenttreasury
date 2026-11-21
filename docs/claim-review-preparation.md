# Preparing the next claim evaluation

The next evaluation corpus now contains 48 new synthetic inputs across eight
coverage categories. Inputs and provisional author labels live separately under
[`benchmarks/claim-review-v1`](../benchmarks/claim-review-v1/README.md). No model,
material parser or investigation policy has been evaluated on these 48 inputs.
Tests check data shape, annotation quote membership and overlap with previous
packet/claim strings; these checks are not model-performance measurements.

The [blank reviewer handoff](evidence/claim-review-v1-blank.json) contains source
statements and empty annotations. It includes no author labels, strata or model
outputs. Send only that form to a reviewer; the repository itself contains the
author labels and therefore cannot enforce blindness.

The `review:claims` command supports export, validation, comparison and label
freezing. It binds every completed annotation to the versioned inputs, rejects
invented sources/quotes, duplicate/missing cases and unexpected fields, and records
provenance declarations. It reports disagreements without treating author labels
as authoritative or fabricating consensus. Existing outputs cannot be overwritten.

The freeze gate accepts only a complete `external-declared` review declaring no
model assistance and no exposure to author labels/model results. Those declarations
are not authenticated: even accepted artifacts remain `independentReview: false`
and `evaluationReady: false`. A frozen label set still needs an execution plan
pinning prompts, model digests, scoring, runtime and code before any evaluation.

No completed external review, label-freeze result or new model score is included.
Automated test reviews are explicitly fixtures and are written only to temporary
directories. The checked-in handoff remains blank and unreviewed. No wallet,
payment provider, running application or existing user database was changed.

Verification on 2026-11-21: the full regression suite passed **298/298** with no
failures or skips (about 32.4 seconds excluding build). Eight new tests cover corpus
separation, blank exports, complete/canonical annotations, invalid inputs and
quotes, disagreement handling, provenance freeze gates and offline CLI behavior.

Next: obtain an actual review using the [handoff protocol](../benchmarks/claim-review-v1/README.md),
validate it, inspect any disagreements, then pin the evaluation execution plan.
Independent review cannot be replaced by a scripted imitation of a reviewer.
