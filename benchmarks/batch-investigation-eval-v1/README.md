# Exploratory batch investigation evaluation v1

This protocol compares a deterministic rule baseline and local model outputs on
the 12-case review packet. It is not a blind benchmark: cases and proposed labels
were already known, the rule explanation mapping was written with that knowledge,
and ten cases are correlated synthetic variations of one modern payment.
Independent human adjudication is still pending.

## Internal label audit

The original input, label and provenance files were left unchanged. The audit
confirmed one corroborated case, four incomplete cases and seven conflicts.
There are 18 proposed mandatory checks and 21 annotated source paths. All paths
exist in their inputs; a null/missing nested authorization is cited through its
existing parent. The raw-delta contradiction is checked through ABI decoding.
The missing-authorization cases are kept separate from wrong-authorization
cases. A failure assertion alongside a charged/journaled record is conservatively
a conflict requiring investigation, not a proven failure or authority to refund.

This verifies internal consistency only. Required checks are not an exhaustive
list of reasonable checks, and annotated paths are not an exhaustive semantic
gold standard. Accordingly, the evaluation reports required-check recall and
exact annotated-path agreement, not check precision or factual citation accuracy.

## Frozen before model execution

`protocol.json` fixes information access, output schema, metrics, error handling,
model order, one pass per model and sampling/context limits. `manifest.json`
binds the protocol, review files, lockfile, source and compiled local dependency
closure, Node/Ollama versions and actual installed model digests. The run refuses
a changed runtime, model or source set. A future evaluated change needs a new
version; do not regenerate this manifest after observing results.

Both methods can use the original evidence and the deterministic raw-batch
validator. Only evidence, that tool result, permitted checks and permitted
citation paths are sent to the model. Case IDs, labels, rationales and mutation
notes are excluded. The Ollama endpoint is fixed to loopback. The evaluator has
no signing, payment, refund or production investigation execution capability.

Model output is gated by an exact schema, at most three unique permitted reads,
and at most eight unique existing citation paths. Invented paths, financial
actions, duplicate entries and extra fields are rejected. Errors and rejected
outputs receive no rule-fallback credit. Parsed false corroboration attempts
remain counted even when the output fails the schema gate.

Strict success requires an accepted output, a correct disposition, all mandatory
checks and exactly the annotated path set. Alternative reasonable citations can
therefore lower this score: inspect the saved per-case outputs before describing
annotation disagreement as hallucination. Precision on accepted paths must be
read alongside path recall and rejected/unavailable counts.

## Run

```sh
npm run eval:batch-investigation -- --rules-only
npm run eval:batch-investigation -- --models qwen2.5:1.5b,qwen2.5:3b
```

The frozen inference CLI requires Node v25.2.1; ordinary application/CI tests
remain compatible with Node 22 and test the runtime mismatch guard there.
Stdout contains the JSON report; progress goes to stderr. Ordinary `npm test`
checks protocol integrity, scoring, label isolation and failure handling without
calling Ollama. Live inference is a separate opt-in command. Results and their
limitations are documented in [Stage 7](../../docs/stage-7-batch-evaluation.md).

One pass and one dominant source family cannot support confidence intervals,
production accuracy, operator-time savings or a model-promotion decision.
The production agent defaults and payment controls are unchanged.
