# Stage 9: bounded multi-step investigation development

This stage tests whether a planner can choose a useful evidence read, observe
its result, and then change its next action. It adds an offline development
runner and evaluation command. The existing production investigation API,
one-shot planner, signer, payment state machine and financial permissions are
unchanged. No live Gateway request, chain transaction or new model default is
introduced.

## Execution boundary

The planner receives a narrow investigation question, the current revision,
requested terms when relevant, and only the records already retrieved. It
selects one read or a terminal advisory conclusion. Five tool names are drawn
from the existing investigation vocabulary: Gateway status, local journal,
original authorization, chain receipt and saved balance evidence.

The development executor binds each tool to the current case through a private
read callback. The planner never receives the hidden response table, case ID,
labels or callback. It cannot supply a request ID, URL or tool arguments. This
is an in-memory fixture boundary, not an implemented live database/RPC adapter.

At most three distinct reads and four planner decisions are allowed. After
the third read, only finishing is available. Repeated reads, citations to
unread records, extra fields and financial actions are rejected before the
read callback executes. Planner snapshots are copies, so mutating the supplied
view does not change the executor's records, target or budget. There are no
payment, refund, budget adjustment or case-closure tools.

A read failure becomes an unavailable observation rather than payment failure.
Missing fields, missing records, stale revisions and non-final receipts prevent
the rule baseline from corroborating. These checks apply to the selected
synthetic record contracts. Corroboration answers only the named comparison;
it does not assert that every payment subsystem agrees, that an individual
nonce is included in a batch, or that a signature/payee is cryptographically
valid.

The model adapter retains raw output, parsed candidates, rejection reasons,
tokens, elapsed time, HTTP status, termination reason, input bytes and an
explicit truncation flag. Each model call has a 45-second deadline, 24,000-byte
input limit, 64-KiB transport-envelope limit and 8,000-character output capture
limit. Structural acceptance does not certify that the conclusion is supported.

## Cases and comparison

Eight invented cases are grouped into pairs with identical initial evidence
and different hidden results:

| Pair | Hidden branch A | Hidden branch B |
| --- | --- | --- |
| Charge versus posting | Matching amounts and transfer IDs | Different posted amount |
| Original authorization | All requested terms match | Original record missing |
| Wallet batch accounting | Final receipt and matching journal delta | Receipt not final |
| Unavailable or partial evidence | Gateway timeout with instruction-like error text | Journal read succeeds but required amount is absent |

The record values are synthetic, including non-address identifiers. No ABI,
signature or chain inclusion verification is claimed by these fixtures. The
earlier live testnet evidence remains a separate artifact.

The deterministic baseline uses only the same visible state as the model. It
reads the sources needed for the question and stops on sufficient evidence or
a required source that cannot be obtained. It cannot inspect hidden fields or
gold labels. Both orders of the two-record comparison receive equal credit,
and the initial context may be cited without displacing required record
citations. The rule policy and labels share an author; this is an exploratory
development comparison, not independent adjudication or a held-out benchmark.

Qwen 3B was chosen because it performed better than 1.5B in Stage 8, not because
it had passed a production threshold. Each case was run once per protocol
version, in fixed order, with temperature 0, seed 42, 256 output tokens and an
8192-token context. There
is no rule fallback credit for a rejected or unavailable model run. Stage 7
and Stage 8 files and results are preserved; scores across the three different
tasks are not directly comparable.

## What is measured

- **Supported success:** correct terminal conclusion, all evidence required
  by an annotated witness retrieved, and citations supporting that witness.
  A correct guess before reading is not success.
- **Useful-read rate:** reads belonging to a sufficient evidence set divided
  by reads made. This is an ex-post annotation metric, not proof that a planner
  should have predicted which unseen source would fail. For example, the rule
  baseline reads Gateway before discovering a partial journal; that first
  read is counted as unnecessary in hindsight.
- **Evidence coverage:** the fraction of a sufficient evidence set retrieved,
  including unavailable responses when they support incompleteness.
- **Citation precision:** agreement with authored support annotations, not an
  independent semantic or human accuracy measurement.
- **Premature finishes and unsupported corroboration:** tracked separately
  from classification accuracy. Parsed corroboration attempts still count
  when their schema is rejected.
- **Time and usage:** complete local investigation duration, model calls and
  reported tokens. Fixture reads have no simulated network wait or fee, so
  these are not end-to-end operator latency or business savings estimates.

## Contract repair and measured results

V1 completed on 2026-11-17 at 09:10:16 UTC. All eight first responses selected
the intended first tool, but included a terminal conclusion on the read. V1
required a placeholder `none` conclusion for reads, so its semantic schema
gate rejected all eight before any tool executed. There were no transport
failures or truncations. This result diagnoses a contract/interface problem;
it does not measure multi-step investigation quality.

V2 was developed after inspecting that failure. A read has only `action` and
`citations`; finishing additionally requires `conclusion`. The JSON schema
expresses these as disjoint alternatives, and the application independently
validates the chosen shape. A read containing any conclusion is still rejected,
not silently repaired. The adapter adds the internal `none` marker only after
validating a conclusion-free read, while preserving the actual wire text.

[Ollama's structured-output documentation](https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx)
describes supplying JSON Schema through `format`; support for this specific V2
schema was exercised against the recorded local runtime, not assumed for all
providers. The change to the schema and corresponding prompt is a development
repair on the same known cases. It is not a blind accuracy improvement. Case
labels, options, executor, rule policy and scoring did not change between runs.

V2's plan was saved at 09:16:47 UTC and completed at 09:17:16 UTC (17:17:16 in
Asia/Shanghai). Both versions used Node v25.2.1, Ollama 0.40.16 and the same
installed Q4_K_M Qwen 3.1B model digest, recorded in their plans.

| V2 method | Correct conclusion | Supported success | Reads | Useful reads | Evidence coverage | Annotated citation precision |
| --- | --- | --- | --- | --- | --- | --- |
| Adaptive rules | 8/8 | 8/8 | 12 | 11/12 (91.7%) | 100% | 100% |
| Qwen 3B | 5/8 | 1/8 | 24 | 10/24 (41.7%) | 93.8% | 47.6% |

All eight V2 model cases completed without schema rejection or unavailable
calls. The model consumed all three permitted reads on every case, then
finished on the fourth decision. Its 32 calls reported 16,019 prompt tokens
and 570 output tokens. Mean investigation time was 3.56 seconds, versus
approximately 0.12 ms for the rule policy over in-memory fixtures. This is
neither a real-tool latency comparison nor a human-workload reduction.

The complete transcripts explain the remaining failures:

- It corroborates the matching charge/posting pair with the right two citations,
  but makes an unnecessary authorization read before finishing.
- It retrieves both sides of the mismatched posting amount but concludes
  incomplete instead of conflict.
- For finalized batch accounting, it never reads the saved balance evidence.
  It spends the remaining reads on journal and Gateway records and ends with
  an unsupported incomplete result. One finish lacks the necessary evidence
  despite exhausting the read budget.
- It correctly reports missing authorization, a pending receipt and Gateway
  unavailability as incomplete, but continues reading unrelated sources and
  includes them as supporting citations.
- It incorrectly corroborates the partial journal whose amount is absent.
  This is one false corroboration. A second corroboration has the correct
  class but lacks the requested-terms citation, giving two unsupported
  corroboration cases in total.

**Decision:** the protocol can now exercise multi-step reads, but the current
3B planner does not beat the adaptive rule baseline. Retain the rule default
and keep the model experimental. Valid JSON and a high fraction of retrieved
evidence do not establish correct reasoning, useful stopping or citation
support. The data and annotations are too small and correlated to infer
production accuracy or general model ability.

## Verification and reproducibility

`npm test`: **222/222 passed**, no skips, approximately 29 seconds excluding
build. Twelve new tests cover paired hidden branches, model input isolation,
tool/citation boundaries, budget enforcement and snapshot isolation, partial
and stale responses, order-independent support scoring, transport diagnostics,
model identity capture and preservation of the Stage 8 implementation. V2 tests
also cover disjoint schemas, wire/canonical output preservation, malformed
shape rejection and preservation of V1's failed-run dependencies. Existing
Stage 7 frozen-file validation also passes. An initial full regression passed
218 tests before V1 inference. Targeted V2 tests completed before V2 inference;
the final full regression ran after it, with no test/inference CPU overlap.

The CLI exclusively creates a pre-inference plan, a completed-case JSONL
capture and a final report. The plan records cases/labels, model digest,
runtime, prompt/options and source/compiled dependency hashes. The evaluator
checks source, dataset, runtime and protocol constants against the plan before
execution. Each completed case is appended and synced with its full turn
transcript. An interruption inside a case can lose that unfinished case's
turns; this development harness is not a durable production workflow engine.

- V1: [plan](evidence/stage-9-investigation-dialogue.json.plan.json),
  [transcripts](evidence/stage-9-investigation-dialogue.json.cases.jsonl),
  [failed-contract report](evidence/stage-9-investigation-dialogue.json).
- V2: [plan](evidence/stage-9-investigation-dialogue-v2.json.plan.json),
  [transcripts](evidence/stage-9-investigation-dialogue-v2.json.cases.jsonl),
  [multi-step report](evidence/stage-9-investigation-dialogue-v2.json).

Both plans' source/compiled dependency hashes and report digests were checked.
All raw outputs were checked against their parsed or canonical decisions;
per-case scores and aggregate summaries were recomputed, and JSONL captures
matched their complete reports.

```sh
npm run eval:investigation-dialogue -- --model qwen2.5:3b --output /tmp/stage-9-new-run.json
npm run eval:investigation-dialogue -- --rules-only --output /tmp/stage-9-rules.json
```

Use new output filenames; existing report and companion files are never
overwritten. No `.env`, wallet credential, real funds or chain connection is
needed. The agreed exclusions remain unchanged, including a frozen 7B rerun.
The default evaluation command uses V2; `eval:investigation-dialogue-v1` retains
the original protocol for reproduction.

## Next step

Connect the bounded read loop to the existing request-bound, read-only case
evidence adapters and expose each observation in the operator investigation
view. Keep the adaptive rule policy as the default, recheck evidence freshness
at completion, and make any model comparison an explicit shadow option whose
conclusion cannot resolve the case. Validate that integration against saved
project evidence and database access boundaries before another model promotion
decision. Model development should target stopping, required-source selection
and claim support on new cases; it should not repeatedly tune this small packet
and present the resulting score as independent evidence.
