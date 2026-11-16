# Stage 4: frozen exception extraction evaluation

The project now has a reproducible stress benchmark for current-incident
extraction, beyond the previous short positive phrases. The main result is
negative for model adoption: neither tested model beats the contextual rule
control under the predeclared gates. This milestone adds evaluation evidence;
it does not promote a model or change the production payment/signing paths.

## What was added

- 36 new synthetic cases: 18 positive, 18 requiring abstention; 20 annotated
  concrete failure signals. Coverage includes paraphrases, negation, resolved
  history, conditional/instructional text, ambiguity and multiple faults.
- Gold support spans separate from model inputs, plus an input-only review
  export. Annotation remains single-author and unreviewed by an independent
  person. These are not company logs or production-distribution samples.
- A contextual rule control that recognizes additional phrasings and suppresses
  explicit negation, historical/resolved statements and conditions. It is
  evaluation-only; the runtime extraction module and its prompt are unchanged.
- A before/after freeze check over the dataset, labels, prompt/extractor,
  model profiles, both scoring/control code and compiled runtime, plus lockfile.
  The runner refuses drift rather than silently comparing changed experiments.
- Separate metrics for concrete signal correctness, negative-case false alarms,
  accepted-output coverage, quote provenance, annotated-span coverage, latency
  and token usage. No rule fallback is credited to a failed model response.

The [dataset protocol](../benchmarks/evidence-exceptions-v2/README.md) defines
the labels, freeze procedure, candidate gates and independent-review workflow.
The corpus is disjoint in wording from prior data, but same-author construction
does not establish blind or independent human validation.

## Actual local run

Run on **2026-11-17, Asia/Shanghai**, with installed Qwen2.5 1.5B and 3B models
and Ollama 0.40.16. The report records full model digests, options, UTC start/end
times and the manifest hash. The 72 model calls completed in approximately
69 seconds. No models were downloaded. No paid or chain APIs were called.

| Method | Accepted outputs | Precision | Recall | Negative false alarms | Exact case success | Mean model latency |
| --- | --- | --- | --- | --- | --- | --- |
| Existing keywords | 36/36 | 48.1% (13/27) | 65% (13/20) | 13/18 | 15/36 | N/A |
| Context rules | 36/36 | 100% (14/14) | 70% (14/20) | 0/18 | 30/36 | N/A |
| Qwen2.5 1.5B | 12/36 | 66.7% (8/12) | 40% (8/20) | 2/18 | 7/36 | 484 ms |
| Qwen2.5 3B | 25/36 | 47.8% (11/23) | 55% (11/20) | 10/18 | 12/36 | 1,424 ms |

Precision counts distinct predicted concrete signals; recall counts the 20
gold signals. Exact case success additionally requires a valid accepted output.
The 1.5B model had 24 rejected responses and 3B had 11, with no unavailable
responses. Rejection means the existing output/provenance validator did not
accept the response; it does not establish that every rejected response was a
semantic misclassification. Raw rejected envelopes are not retained in this
report, so their precise rejection causes are not attributed here.

Negative false-alarm rate must be read together with acceptance and negative
success. The 1.5B model's relatively low 2/18 false alarms did not indicate good
abstention: it correctly completed **0/18** negative cases, mostly because its
responses were rejected. The 3B model completed **3/18** negative cases correctly.
The contextual rule control completed all 18, on this small authored set only.

| Method | Verbatim quote rate | Annotated-span coverage | Input/output tokens |
| --- | --- | --- | --- |
| Keywords | 100% | 60% | No model calls |
| Context rules | 100% | 70% | No model calls |
| Qwen2.5 1.5B | 91.7% | 35% | 10,613 / 752 |
| Qwen2.5 3B | 82.6% | 40% | 10,613 / 1,612 |

The runtime quote validator permits normalized case/whitespace; the benchmark's
verbatim measure is stricter. Annotated-span coverage requires the entire gold
support span within a source quote. It is a conservative alignment check, not
an independent entailment judgment. A shorter valid quote may lose span credit.
Token usage measures local inference work, not a dollar cost or financial ROI.

Both models failed the predeclared candidate gates. Against context rules,
1.5B repaired 3 cases but regressed on 26; 3B repaired 4 but regressed on 22.
Regressions include validation failures, not just wrong diagnoses. The paired
case IDs and category breakdowns are in the
[raw measured report](evidence/stage-4-exception-models.json).

## What the failure analysis supports

1. **Copied evidence does not make a diagnosis true.** The test includes a
   verbatim phrase inside a denial. Source membership passes while the concrete
   failure claim is false. Prompt-injection and resolved-history cases expose
   the same distinction. Interpretations must remain unverified.
2. **A stronger rule control matters.** Context handling removes many keyword
   false positives while preserving direct detections. Comparing only against
   keyword recall would overstate the model's value.
3. **Output acceptance is a real engineering constraint.** Accepted-output
   precision alone hides how many requests produced no usable answer. Failed
   output receives no correct-negative credit and no fallback reward here.
4. **There is a narrow semantic opportunity, not demonstrated overall ROI.**
   Models repair some paraphrases missed by context rules. The regressions and
   false alarms outweigh those gains in this run. No default model promotion
   or claim of reduced human review is justified.

The previous 10-string frozen test and this benchmark use different cases and
task definitions. Here `unknown-error` is abstention and only current concrete
faults count. These percentages are not directly comparable with the previous
eight-label recall numbers. No 7b frozen-set rerun was performed.

## Run and review

```sh
npm run test:exceptions
npm run eval:gateway-exceptions -- --rules-only
npm run eval:gateway-exceptions -- --models qwen2.5:1.5b,qwen2.5:3b
node scripts/export-exception-review.mjs > /tmp/exception-review.json
```

The model CLI requires installed models, sends only source text and the frozen
system prompt, and reports progress on stderr. Stdout is the JSON report.
Reviewer exports contain blank annotations and are marked `unreviewed`; do
not send the gold labels or model scores to a blind reviewer.

Local verification on 2026-11-17: `npm test` passed **171/171**, with no
skipped tests and approximately 28 seconds of test execution excluding build.
The new regression tests cover context suppression, copied-but-unsupported
quotes, duplicate prediction scoring, abstention versus unavailable output,
data/runtime freeze verification, label isolation, token accounting, candidate
gates and the reviewer export. A real model run is not part of ordinary CI;
CI replays the deterministic tests and checks the freeze without Ollama.

After seeing these results, do not tune on this frozen set and present the next
score as blind validation. Future extraction changes need separate development
cases and a new versioned evaluation. Independent human label review, real
testnet/provider incident sampling, repeated-run uncertainty and actual operator
time remain unverified. No synthetic benchmark establishes production accuracy
or a reduction in human workload.

Next engineering milestone: testnet-only event ingestion and replay with
explicit provenance, to improve the quality of operational evidence and future
exception samples. Retain the existing rule execution and advisory-only model
boundaries. Docker/soak and OS-enforced signer-isolation acceptance remain open
from earlier milestones; the agreed version exclusions remain unchanged.
