# Designing and validating the agent's increment

The newer [Stage 4 exception benchmark](stage-4-exception-evaluation.md) adds contextual negative cases and a stronger rule control. Neither measured model passes its candidate gates. Earlier development-set gains below are not evidence of production or current-incident generalization.


For the 2026-11-17 bounded execution implementation, stricter citation validation and new local model measurements, see [Stage 3 investigation](stage-3-investigation.md). The historical measurements below use their original evaluation protocol.


This document answers one question: **where does the AI agent actually add value over the deterministic rules, and how is that shown?** It is the summary of three candidate increments, each built, measured on a development dataset, and recorded honestly — two positive, one negative. The detailed per-case evaluation logs live in [gateway-triage-evaluation.md](gateway-triage-evaluation.md); this document is the narrative a hiring conversation would follow.

## The starting point: the agent was not adding value

The triage agent was originally constrained to "pick an action from the candidates the rules generate, with citations validated against the facts". Under that design the rules already score 100% on every dataset, so the best a model can do is tie — and it adds hundreds of milliseconds of latency to do so. The honest held-out result was **no positive increment**, recorded rather than papered over.

The fix is not "make the model smarter". It is to stop asking the model to choose between rule-generated options, and instead give it a task the rules structurally cannot do.

## The method

For each candidate increment:

1. Define a **closed output set** (not free text), so every output is machine-checkable.
2. Build a **rule baseline** that represents what the structured code already does.
3. Run the rule baseline and a local model on the **same development inputs** and compare recall / precision (or accuracy).
4. Require the model to **cite its evidence** and validate those citations server-side.
5. Keep every proposal **read-only**: the agent suggests, the backend enforces limits, and nothing executes a write.

The three candidates, ordered by how testable they are:

| # | Candidate | Hypothesis |
| --- | --- | --- |
| A | Unstructured evidence extraction | Read free-text error strings and emit failure signals the keyword table cannot enumerate. |
| B | Read-only investigation suggestions | When evidence conflicts, propose the next check the operator should run. |
| C | Cross-case pattern recognition | Cluster several failures from one supplier/network into a systemic problem. |

## Method boundary: development, not held-out

The datasets below are development sets: the signal definitions and prompts were tuned against them, so the numbers carry an optimistic bias and must not be read as held-out generalization. A frozen test set (`gateway-evidence-test-v1`, ten strings authored after the prompt freeze) is measured separately; its ten samples support method/model comparison but are too small to claim held-out generalization to production traffic. What the numbers do show honestly is whether a model can even reach the rules on the exact inputs that shaped the prompt — a necessary first check, not a production guarantee.

## Results

Measured on 2026-11-16 on an Apple Silicon Mac, local Ollama, temperature zero.

### A. Unstructured evidence extraction — positive

`gateway-evidence-v1`: 20 free-text failure strings, 10 direct phrasings and 10 paraphrases that mean the same thing without the keyword ("signed twice with the same identifier" for nonce reuse, "the wallet ran dry" for insufficient funds).

| Method | Recall | Precision |
| --- | ---: | ---: |
| Keyword rules | 0.50 | 1.00 |
| `qwen2.5:0.5b` | 0.85 | 0.85 |
| `qwen2.5:1.5b` | 0.85 | 0.94 |
| `qwen2.5:3b` | 0.95 | 0.95 |

The keyword table catches every direct phrase and misses every paraphrase. `3b` recovers the paraphrases at a small precision cost. This is wired into triage as separate, unverified keyword/model interpretations with source observation references. Stage 0 keeps them out of recorded facts and action citations, and saves both categories in the advisory review snapshot.

The numbers above were tuned in the loop, so they overstate generalization. After freezing the prompt, a separate ten-string held-out set (`gateway-evidence-test-v1`) was authored and measured once, without touching the prompt:

| Method (held-out) | Recall | Precision |
| --- | ---: | ---: |
| Keyword rules | 0.50 | 1.00 |
| `qwen2.5:0.5b` | 0.30 | 1.00 |
| `qwen2.5:1.5b` | 0.80 | 1.00 |
| `qwen2.5:3b` | 0.70 | 1.00 |

The held-out measurement keeps the direction of the claim — models recover reworded failures the keywords miss — but lowers its magnitude: the best model reaches 0.80, not 0.95, and 0.5b falls below the rules.

### B. Read-only investigation suggestions — negative

`gateway-investigation-v1`: eight conflicts with hand-labeled "first checks to run", over a closed set of eight read-only investigations.

| Method | Recall | Precision |
| --- | ---: | ---: |
| Rules (generic checklist) | 0.53 | 0.38 |
| Rules (signal-to-check mapping) | 1.00 | 1.00 |
| `qwen2.5:0.5b` | 0.12 | 0.17 |
| `qwen2.5:1.5b` | 0.59 | 0.43 |
| `qwen2.5:3b` | 0.59 | 0.42 |
| `qwen2.5:7b` | 0.59 | 0.50 |

The models never beat the baseline, and pulling `7b` does not help — it still emits a fixed checklist with an `read-original-authorization` preference instead of reasoning about the conflict. The reason: "what to check next" is a deterministic `fact -> check` mapping, which the rules encode exactly. The read-only, auditable capability is kept with the exact rule mapping as the default.

### C. Cross-case pattern recognition — positive

`gateway-patterns-v1`: six batches of three failures, two paraphrased and one with no shared cause, over a closed set of six systemic patterns.

| Method | Accuracy |
| --- | ---: |
| Shared-signal counting | 0.67 |
| `qwen2.5:0.5b` / `1.5b` / `3b` | 0.83 |
| `qwen2.5:7b` | 1.00 |

Shared-signal counting misses the two paraphrased batches; the models recover them. `7b` reads all six batches correctly, including the mixed batch it must label `no-systemic-pattern`. The small models' single miss is over-claiming a pattern on the mixed batch — the same false-positive cost as extraction.

## The rule of thumb

The three results reduce to one sentence:

> **The model adds value on semantic tasks, and none on structured mappings.**

- **Semantic tasks** (extract a signal from free text, cluster paraphrases across cases) are tasks the keyword table cannot cover, and a small local model can generalize on. Both positive results land here.
- **Structured mappings** (choose the next check from facts) are tasks the rules can encode exactly, and the model cannot beat them even at 7b. The negative result lands here.

"Give the agent a task the rules cannot do" is therefore necessary but not sufficient — the task must also be one the available model can actually generalize on. This is the difference between a claimed AI capability and a measured one.

## What this lets you claim, and what it does not

**Claimable:**

- The agent's value is demonstrated on two specific development-set tasks (signal extraction, cross-case clustering), with rule baselines and per-model recall/precision.
- The failure is demonstrated too: the agent is *not* used where a deterministic mapping is exact, and that decision is backed by a 7b comparison rather than intuition.
- Extracted signals are closed-set, read-only interpretations with source quotes. The backend checks quote provenance, not semantic truth; interpretations remain unverified and cannot satisfy action citations. Cross-case pattern outputs remain advisory labels.

**Not claimable:**

- Held-out generalization is limited. The development sets were tuned in the loop; the frozen `gateway-evidence-test-v1` set is now measured (rules 0.50 recall, 0.5b 0.30, 1.5b 0.80, 3b 0.70), but at ten synthetic strings it supports method/model comparison, not production operator-time or review-rate claims.
- No production operator-time reduction is shown. The evaluations measure decision correctness and evidence, not minutes saved; an operator pilot exists as a harness but real timing data is not collected.
- No claim that "the agent reduces human review" in production — the datasets are synthetic fixtures, and the models add latency.
- No claim that the agent beats the rules everywhere — it wins on two semantic tasks and ties/loses on the structured one.

## Reproduce

```sh
npm run build

# A: unstructured evidence extraction
npm run --silent eval:gateway-evidence -- --rules-only
npm run --silent eval:gateway-evidence -- --models qwen2.5:0.5b,qwen2.5:1.5b,qwen2.5:3b

# B: read-only investigation suggestions
npm run --silent eval:gateway-investigation -- --rules-only
npm run --silent eval:gateway-investigation -- --models qwen2.5:0.5b,qwen2.5:1.5b,qwen2.5:3b
npm run --silent eval:gateway-investigation -- --model qwen2.5:7b

# C: cross-case pattern recognition
npm run --silent eval:gateway-patterns -- --rules-only
npm run --silent eval:gateway-patterns -- --models qwen2.5:0.5b,qwen2.5:1.5b,qwen2.5:3b
npm run --silent eval:gateway-patterns -- --model qwen2.5:7b
```

The rule baselines and the scoring are covered by unit tests (`gateway-evidence-extraction.test.ts`, `gateway-investigation.test.ts`, `gateway-patterns.test.ts`), so the positive and negative baselines are reproducible without Ollama. The model numbers are measurements on this fixture set, not production claims.
