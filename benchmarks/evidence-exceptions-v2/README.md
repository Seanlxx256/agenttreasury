# Evidence exceptions v2

This is a frozen, project-authored **synthetic stress test**, not production
traffic or independently adjudicated human ground truth. New strings are
disjoint from the old development and frozen test texts. The same project
author designed the cases and labels; conceptual independence is not claimed.

## Task and annotation

Extract currently asserted concrete failures in the seven-signal taxonomy:
nonce reuse, insufficient funds, disallowed recipient, invalid signature,
already-processed batch, expired authorization and unavailable RPC/API.
Negated, resolved, conditional, instructional and unconfirmed text is not an
active failure. `unknown-error` is treated as abstention in this protocol,
rather than an eighth diagnosis. Do not compare these metrics directly with
the old eight-label evidence benchmark.

- `inputs.json`: opaque case IDs and source text only.
- `labels.json`: category, expected concrete signals, supporting character
  intervals `[start, end)` and annotation rationale. Empty expected sets mean
  no supported concrete diagnosis, not necessarily a healthy payment.
- `manifest.json`: SHA-256 hashes of inputs, labels, extraction code/prompts,
  model profiles, context baseline, scorer, runner, compiled JS and lockfile.

The 36 cases contain 18 positive cases with 20 concrete signals and 18 cases
where abstention is appropriate. Categories are direct statements, paraphrases,
negation, resolved incidents, instructions/conditions, ambiguity, mixed context
and multiple faults. The context rule baseline was created in the same
milestone before the first model run; it is a stronger control than plain
keyword matching, not a claim to the best possible deterministic system.

## Freeze and repeat

The manifest was created before the first real model call. The runner verifies
it before and after evaluation and refuses data, prompt, rule, scorer or runtime
drift. The freeze script uses exclusive file creation and cannot overwrite a
manifest. Git history is still the trust boundary: a repository owner could
rewrite both data and hashes. The hash is not an external timestamp or signature.

```sh
npm run eval:gateway-exceptions -- --rules-only
npm run eval:gateway-exceptions -- --models qwen2.5:1.5b,qwen2.5:3b
```

The CLI checks that requested models are already installed, records model
digests and Ollama version, and never downloads a model. Model prompts receive
only each input text plus the existing extraction system prompt. Gold labels,
support spans, case IDs, categories and reviewer rationale are not sent.

Future prompt, rule, data, compiler or scoring changes require a new benchmark
revision or an archived checkout for reproducing this exact run. Do not update
this manifest merely to make a failing check green. Seeing these results makes
this set unsuitable for subsequent blind model tuning.

## Scoring and limitations

Concrete signals are deduplicated per case. False positives and false negatives
are both counted. Invalid/unavailable model responses are not replaced with
rules and do not earn correct-negative credit. Reports distinguish false alarms
on negative cases from operational success on those cases, so outages cannot
masquerade as safe abstention. Mixing `unknown-error` with concrete diagnoses is
reported separately.

Exact source quotation and annotated-span containment are different checks.
A copied phrase can be inside a denial or instruction and still be wrong.
Annotated-span coverage is a conservative alignment metric: it requires the
quote to contain the complete gold span. It can undercount a valid shorter
quote and does not prove semantic entailment or independent truth.

Candidate gates were fixed before measurement: at least 10 percentage points
of recall gain over context rules, precision at least 95% and no worse than
context rules, negative false-positive rate at most 5% and no worse than the
control, at least 95% model availability/acceptance, no mixed abstentions,
non-decreasing annotated-span coverage and mean latency at most 3 seconds.
Passing is only a candidate for independent review, not production approval.
With 18 negatives, one false alarm already exceeds the 5% point-estimate gate.

This is one local pass per model. Model loading, caching and scheduling affect
latency; token counters measure local inference volume, not a dollar bill.
No confidence interval, population error rate, human review reduction or
production ROI is established by 36 synthetic examples.

## Independent review remains pending

Prepare an input-only template for a separate reviewer:

```sh
npm run build
node scripts/export-exception-review.mjs > /tmp/exception-review.json
```

Give that reviewer only the template and annotation instructions, not
`labels.json` or model scores. Record reviewer identity and uncertainty, compare
disagreements, then version any corrected dataset. The template is marked
`unreviewed`; creating it is not evidence that review occurred.
