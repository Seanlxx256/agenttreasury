# Stage 8: compact evidence and observable model failures

This stage adds a development-only experiment, not a new production payment
policy. Backend validators compare original authorization terms, journal
postings, Gateway references, raw batch calldata and wallet accounting. The
model selects read-only investigation checks and cites the evidence behind
its disposition. No model output pays, refunds, releases a reservation or
closes a case.

## Observable output validation

The new adapter records accepted and rejected model text, a parsed candidate
status when available, exact rejection codes and JSON paths, HTTP status,
input bytes, tokens, termination reason and elapsed time. Schema-valid wrong
answers remain visible as wrong answers; they are not converted into rule
successes. Parsed false corroboration claims count even when rejected later.

Rejection diagnostics distinguish missing/extra fields, invalid dispositions,
unpermitted checks/citations, duplicates and count limits. Malformed output
JSON, a missing content field, malformed transport envelopes, HTTP failures,
timeouts and other transport errors have separate codes. The transport
envelope is capped at 64 KiB; model text is retained up to 8,000 characters
with an explicit truncation flag. An oversized transport envelope is rejected
before parsing, so no model text or token totals can be recovered from it.
Input payloads are limited to 48,000 bytes. Calls time out after 45 seconds.

Only the included synthetic development data is accepted by the CLI. Raw
outputs can repeat input text and are not a general-purpose production log:
do not adapt this capture mechanism to private customer data or credentials
without a separate retention/redaction design.

## Matched input views

Both views receive the same deterministic facts, citation catalog, prompt,
schema and decoding settings. The full view additionally includes original
records and raw calldata; compact omits those records and supplies states
with source pointers. Each pointer resolves against the original evidence in
the saved plan. The compact view exposes all comparison states, not just
failures, and includes an exact evidence digest. It does not expose an overall
gold disposition or label rationale.

The backend retains a wallet-level closing-balance discrepancy even when the
individual batch posting agrees. A validator failure prevents a clean
corroboration; dependent linkage comparisons become unavailable. Revision
differences and unsuccessful provider refreshes mean current evidence is
missing, not that the payment failed. These revision/provider fields are
synthetic experiment inputs, not newly wired production freshness checks.

These facts substantially simplify the model's task. This experiment tests
presentation and bounded selection on top of hard checks; it does not show
that a model can independently validate ABI data, discover a financial root
cause, or improve on deterministic consistency rules. Source references are
traceable backend claims, not cryptographic proofs of individual nonce
inclusion, signatures or payee entitlement.

## New development cases and protocol

Eight cases use invented request IDs, addresses, nonces, balances and ABI
batches generated independently of the Stage 6/7 packet. They cover:

- Consistent current evidence.
- Simultaneous authorization-recipient and journal-amount conflicts.
- A stale revision despite otherwise matching records.
- Provider failure containing untrusted instruction-like error text.
- Missing authorization and current journal records.
- A nonce conflict together with stale evidence.
- A closing-balance discrepancy despite matching batch postings.
- A normalized batch delta that contradicts its raw calldata.

The cases share a generator, and their labels were written by the same
developer. They are explicitly **development data**, not a held-out set or
independent review. The rules baseline and labels were checked before model
inference. The missing-journal case allows a historical posting citation as
additional evidence; that does not substitute for the missing current record.

Each model gets one full and one compact call per case. View order alternates
by case to reduce a simple first-call bias; model order remains 1.5B then 3B.
Settings are temperature 0, seed 42, 512 output tokens and context 8192.
Caches, model loading and this single run still confound latency comparisons.

The CLI writes a plan with source/compiled dependency hashes, lockfile hash,
cases and labels, exact call order, model digests, Node and Ollama identity
before inference. It checks source/data/runtime against that plan before
execution. Exclusive file creation avoids replacing earlier results. Each
completed call is appended and synced to JSONL so an interruption retains
completed observations; a complete report is written only at the end.

Artifacts for this run:

- [Pre-inference plan](evidence/stage-8-batch-development.json.plan.json)
- [Call-by-call capture](evidence/stage-8-batch-development.json.calls.jsonl)
- [Completed report](evidence/stage-8-batch-development.json)

Strict success requires a correct disposition, all mandatory checks and
required paths, and no path outside the label's allowed set. Citation precision
is agreement with those authored annotations, not independent semantic
entailment accuracy. Unaccepted outputs receive no fallback credit. These
scores must not be compared directly with Stage 7's different data and prompt.

## Measured development results

The plan was saved at 2026-11-17 08:52:28 UTC; the run completed at 08:55:38
UTC (16:55:38 in Asia/Shanghai). Runtime was Node v25.2.1 and Ollama 0.40.16.
The plan contains full digests for the installed Q4_K_M 1.5B and 3.1B models.
All 32 calls returned schema-valid output, with no rejection, unavailability,
missing usage or truncated capture in this particular run. Diagnostic failure
paths are covered by tests rather than claimed as observed model incidents.

| Method | Correct disposition | Strict success | Mandatory-check recall | Annotated-path precision | Mean time |
| --- | --- | --- | --- | --- | --- |
| Rules | 8/8 | 8/8 | 100% | 100% | Not used for latency comparison |
| 1.5B, full | 5/8 | 0/8 | 38.5% | 33.3% | 6.50 s |
| 1.5B, compact | 3/8 | 0/8 | 38.5% | 34.4% | 2.06 s |
| 3B, full | 6/8 | 0/8 | 76.9% | 29.7% | 11.86 s |
| 3B, compact | 7/8 | 0/8 | 92.3% | 34.7% | 3.21 s |

The full payloads total 42,709 bytes versus 13,230 compact bytes, a 69.0%
reduction. Each model reported 26,642 prompt tokens for full inputs and 5,090
for compact inputs, an 80.9% reduction in reported usage. Output tokens were
700/792 for 1.5B full/compact and 614/736 for 3B. The 32 measured calls took
189.1 seconds combined. These are local measurements, not dollar savings or
production latency guarantees.

The failure evidence is more useful than the small classification improvement:

- 1.5B compact emits essentially the same `incomplete` classification and
  generic checklist for all eight cases, including explicit conflicts.
- 3B compact correctly classifies seven cases but often cites unrelated matched
  records. On stale-record and provider-error cases it omits the complete
  evidence needed to justify its conclusion. In the mixed nonce/staleness
  case it identifies conflict but fails to cite both revision records.
- Both models call the fully consistent case incomplete in both views. There
  are zero false corroborations, but neither model emits corroborated at all;
  this is not evidence of reliable safe/unsafe discrimination.
- Some strict failures are conservative annotation requirements. For example,
  3B full identifies raw batch corruption with a useful calldata check but
  omits the annotated balance check. Strict failure does not make every part
  of that response useless. It still provides no evidence of superiority to
  the rules baseline on this structured task.

No prompt, label or rule was changed after inference began. All saved raw
outputs were parsed back against the accepted decisions; per-case and aggregate
scores were recomputed. JSONL matched the completed report, and the plan digest
and full source/compiled dependency hashes matched the recorded run.

**Decision:** keep the compact adapter as a development option, preserve rules
as the consistency classifier, and do not promote either model. Compression
reduced input size and measured wait time; dependable evidence selection and
incremental operator value remain unproven.

## Verification and scope

`npm test`: **210/210 passed**, no skips, approximately 31 seconds excluding
build. Seven new tests cover both views, source references, multi-conflict and
freshness handling, bounded output capture, rejection details, scoring and
pre-inference model identity capture. The existing tests also verify that
Stage 7's frozen source, compiled dependencies, inputs and labels are unchanged.
Full tests completed before measured model inference began.

This stage makes no database migration, production model change or live
payment. The agreed exclusions remain: mainnet/real funds, a frozen 7B rerun,
A402, payee cryptographic validation, sharding and a message queue.

Reproduce with the installed development models, using a new output filename:

```sh
npm run eval:batch-development -- --models qwen2.5:1.5b,qwen2.5:3b --output /tmp/stage-8-new-run.json
```

For the deterministic baseline without Ollama:

```sh
npm run eval:batch-development -- --rules-only --output /tmp/stage-8-rules.json
```

The report filename, its `.plan.json` companion and its `.calls.jsonl` companion
must not already exist. Interrupted runs leave partial artifacts deliberately;
retain them and choose another output name rather than overwriting evidence.

## Next step

Keep rules responsible for structured consistency classification. The next
experiment should measure the investigation work that rules do not already
settle: selecting a useful next evidence read, handling that tool's partial or
conflicting response, and producing a supported operator explanation. Build
multi-step cases whose additional evidence is hidden until requested, allow
multiple defensible read sequences, and review their annotations before a
fresh evaluation. Compare useful-read rate, evidence coverage, unsupported
claims and time/cost with the bounded rule workflow. Do not promote a model
or claim reduced human workload until that incremental value is demonstrated.
