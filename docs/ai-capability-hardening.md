# AI capability hardening: claims, materials and guided investigation

This extension addresses weak claim interpretation, coarse material checklists and
the gap between the offline dialogue experiment and the actual investigation API.
It does not establish production model accuracy or measured human savings.

## Available behavior

The optional structured claim adapter distinguishes `current`, `denied`,
`hypothetical`, `resolved` and `uncertain` statements. Every interpretation retains
its source ID, exact quote and source digest. Denied/hypothetical/resolved candidates
remain visible, but do not enter the model's active issue list. Existing whole-source
context holds, rule/model disagreements and operator topic selection remain in force;
a model cannot clear them by asserting that a statement is resolved.

For example, "I was not charged twice. The download is unusable" can be represented
as two separate interpretations instead of two current complaints. This is a model
suggestion, not verification of either sentence. The console shows all states.
Changed source text makes previous interpretations stale. No statement supplies
payment truth, refund entitlement or a financial instruction.

The material parser identifies explicitly supplied order/charge references, amounts,
networks, times, error codes, expected results, refund hashes and recipients. Its
output is visible even when no model is configured. The structured view additionally
lists requirements per current/uncertain claim and separates `provided-unverified`
from `not-extracted`. It does not silently use one party's material for another's
claim or remove existing questions. A reviewer must verify linkage, validity and
completeness. Two quoted references can still describe the same charge.

Material parsing is deterministic engineering, not model intelligence. The initial
3B material output failed badly, so raw model material candidates are retained as
review-only diagnostics and do not populate the supplied-field checklist. Unknown
formats, unlabeled values and non-English wording may be missed. Text mentioning a
value hypothetically may still yield a lexical candidate; no extraction verifies it.

The guided investigation mode is connected to the existing authenticated API and
uses the actual read-only collector/executor. It runs at most three distinct checks
from the backend's rule checklist. An optional model orders remaining checks using
normalized facts and bounded findings from prior reads. It never receives raw provider
instructions, arbitrary SQL, URLs, credentials or tool target parameters.

- Recheck the local snapshot before planning and again before each read.
- Reject invented/repeated choices and use rule ordering on model failure.
- Stop on changed snapshots or unavailable/blocked required evidence, retaining
  the unmet checklist and each executed read's unique evidence ID.
- Stop when the checklist is collected, without a redundant model finish call.
- Save turns, selection origin, stop reason and remaining checks in the ordinary
  advisory report. The console displays this trace.

`checklist-collected` means only that the bounded checklist was collected. Records
may conflict, omit relevant evidence or describe an unsettled payment. This is
guided evidence collection, not a model-certified diagnosis. The rule checklist can
itself be incomplete. No model advantage for read ordering has been measured. A
process crash can still lose an unfinished report; this is not a durable agent engine.

## Actual paired model experiment

Twelve new author-labelled development cases were written after inspecting earlier
failures. They are distinct from the previous packet strings but are not an unseen,
independently adjudicated test set. Both adapters used the same installed Qwen2.5 3B;
call order alternated across cases. No labels entered the production model prompts.
The plan pins model digest, runtime, source/compiled hashes and dataset. Raw outputs,
rejections, timings and completed cases are saved before the final report.

| Measure | Context rules | Previous model adapter | Structured adapter |
| --- | ---: | ---: | ---: |
| Current topic/source sets exactly correct | 7/12 | 4/12 | 8/12 |
| Correct current sets with annotated quote support | Not the primary comparison | See per-case artifact | 8/12 |
| All assertion states exactly correct | Not applicable | Not available | 6/12 |
| Rejected or unavailable attempts | Not applicable | 0/12 | 1/12 |

The structured model found **0/13** expected material fields and produced two
unsupported material candidates. One full response was rejected for adding text
not present in the original statement. These failures remain in the report and
denominator. The new parser was subsequently developed on those observed cases;
its replay found **13/13** expected fields with zero unsupported candidates under
these authored labels. That is development coverage, not a model gain, held-out
result, general semantic accuracy or reduction in human work.

- [Paired report](evidence/claim-assessment-development-3b.json)
- [Pre-inference plan](evidence/claim-assessment-development-3b.json.plan.json)
- [Raw per-case capture](evidence/claim-assessment-development-3b.json.cases.jsonl)
- [Subsequent deterministic replay](evidence/claim-material-development-replay.json)

The captured model run precedes the material-parser integration. Current source
hashes differ; the original report is preserved rather than rewritten. The modest
gain on twelve known development cases does not justify default model promotion.

## Enable and evaluate

Local verification on 2026-11-21: `npm test` passed **290/290**, with zero failures
or skips (about 41 seconds excluding build). Fifteen added tests cover provenance,
claim/material separation, stale and cross-party evidence, bounded parsing, guided
execution/fallback/stopping, and actual PostgreSQL-backed API persistence without
financial mutation. The local paired model run took about 56 seconds; its 24 model
calls totaled about 55.5 seconds. No production throughput or human-time claim is
inferred from these timings.

Material candidates appear on newly generated/revised packets without a model.
Old stored reports remain unchanged. To opt into structured model interpretation
and guided collection, configure the API process and restart it:

```sh
export GATEWAY_CASE_PACKET_ANALYSIS=structured
export GATEWAY_CASE_PACKET_MODEL=qwen2.5:3b
export GATEWAY_INVESTIGATION_MODE=guided
# Optional experimental ordering; omit for deterministic guided ordering:
# export GATEWAY_INVESTIGATION_MODEL=qwen2.5:3b
```

The model must already be installed and served by local Ollama. Model extraction
remains disabled without its model variable; legacy interpretation/investigation
remain available without the new mode variables. No database migration is needed.
Existing financial permissions and external-read opt-in/testnet restrictions apply.
No user service, wallet or existing database was changed during implementation.

```sh
npm test
npm run eval:claim-assessment -- --model qwen2.5:3b --output /tmp/claim-assessment-new.json
node scripts/evaluate-material-replay.mjs \
  --input docs/evidence/claim-assessment-development-3b.json \
  --output /tmp/material-replay-new.json
```

Evaluation refuses to overwrite output artifacts. An empty final file with only
partial sidecars is not a completed run. Replays do not invoke a model or payment
provider. Human savings remain unverified: the next evidence step is independently
reviewed new cases, followed by the controlled operator study described in
[Stage 12](stage-12-case-packet-effort.md). Larger-model frozen-set reruns and the
previously excluded mainnet/infrastructure items are not required by this extension.
