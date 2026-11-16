# Arc Gateway triage evaluation

The rule baseline gave the labeled next action in 11 of 12 scenarios. The local Qwen2.5 0.5B agent gave it in 6 of 12. It correctly escalated the case where retries were exhausted and Gateway was unavailable. It also recommended escalation for four cases where the label called for a specific operational action. The model had two rejected responses.

| Metric | Rules | Qwen2.5 0.5B |
| --- | ---: | ---: |
| Correct next action | 11/12 | 6/12 |
| Complete, supported citation set | 10/12 | 9/12 |
| Recommendations displayed | 12/12 | 10/12 |
| Recommended escalation or conflict review | 2/12 | 7/10 |
| Rejected responses | — | 2 |
| Model unavailable | — | 0 |
| Mean generation time | 0.02 ms | 819 ms |

The model chose escalation when an empty nonce lookup called for a fresh query, when active polling had a pending transfer, when the seller already held a retrievable trace, and when missing delivery called for contacting the merchant. The server rejected responses for the case with no prior lookup and the paused payment that was still pending. In the correct escalation case the model omitted the fact that polling was paused.

The citation metric checks reference IDs against the labeled evidence. A manual reading found that some explanations contradicted the selected action. For the expired reservation, the model selected closure and cited the expiry observation, while its explanation called for escalation. The action and citation scores do not measure whether the explanation itself follows from the evidence.

## Reproduce

- Dataset `gateway-triage-v1` has 12 hand-labeled synthetic incidents.
- Code revision `d17500c` was evaluated on 2026-11-15 on an Apple M2 Mac.
- Ollama `0.40.16` ran `qwen2.5:0.5b` locally at temperature zero. The model manifest SHA-256 was `a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67`.
- The mean generation time includes the first request. Human handling time and production incident quality require separate measurement.

With the model loaded in a locally running Ollama:

```sh
npm run build
npm run --silent eval:gateway -- --model qwen2.5:0.5b
```

## Arc testnet recovery replay

Dataset `arc-recovery-v1` replays three stages of the [lost paid response drill](../README.md#exercise-recovery-after-a-lost-paid-response). The first stage uses the observed state after the connection closed and before the buyer's first Gateway lookup. The middle stage reconstructs the point between posting the charge and retrieving the seller trace, in the order the successful recovery executed. The final stage uses the observed state after recovery and verification. The replay reduces purchase records to the facts the finance console sends to triage and assigns local IDs to the selected observations.

| Stage | Expected action | Rules | Qwen2.5 0.5B |
| --- | --- | --- | --- |
| Paid response lost and payment status unknown | Check the original authorization | Check Gateway | Response rejected |
| Charge confirmed and buyer trace missing | Retrieve the seller trace | Retrieve delivery | Escalate |
| Trace recovered and journal posted | Close the case with delivery and journal evidence | Close case, omits journal citation | Close case, omits journal citation |

On 2026-11-15, the rules scored **3/3** for action and **2/3** for a complete citation set. The same local Ollama and Qwen configuration scored **1/3** for action and **1/3** for a complete citation set. It returned one escalation, one closure recommendation, and one rejected response. Mean model generation time was 1.22 s including the first request.

In the retrieval case, the model cited all the labeled evidence but claimed in its explanation that the polling flag established the charge. In the closure case it mentioned the posted journal without citing it, and inferred that the case was already closed. The citation score checks relevant fact IDs and coverage of the required set. These three stages describe one purchase and do not establish accuracy across independent incidents or any reduction in operator time.

```sh
npm run build
npm run --silent eval:gateway -- --dataset arc-recovery-v1 --model qwen2.5:0.5b
```

Use `--rules-only` in place of `--model qwen2.5:0.5b` to run without Ollama. The default dataset remains `gateway-triage-v1`.

### Rerun with the journal citation required

The triage policy now requires a journal citation for a delivered purchase when the journal is present. Using the same replay and local model, the rule action score stayed at 3/3 and citation completeness rose from 2/3 to 3/3. Qwen's action score stayed at 1/3 and citation completeness rose from 1/3 to 2/3. The validator still rejected one response.

Manual review found issues with both displayed model explanations. For retrieval, it again treated the polling flag as proof of a charge and recommended escalation. For closure, it selected `close-case` and cited the journal, then said in its explanation that no action could be recommended. The rule explanation for closure cites the posted journal and saved buyer trace. Citation completeness measures the referenced facts, and a human review is still needed to assess free-form explanations.

### Server explanations and separate incident replay

The model now proposes an action and citations. After validation, the server supplies the explanation tied to that action and its required evidence. The [finance console](../README.md) displays the validated recommendation. The regression test returns a contradictory instruction from a stub model and verifies that the displayed explanation comes from the server.

On 2026-11-15, the same local Qwen2.5 0.5B configuration scored as follows. `gateway-incidents-v1` contains six separately authored synthetic purchases. It includes a paused worker during a Gateway outage, multiple transfers for one nonce, and a failed payment with a seller trace on file.

| Dataset | Rule actions | Model actions | Complete rule citations | Complete model citations | Model responses displayed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Arc recovery stages | 3/3 | 1/3 | 3/3 | 2/3 | 2/3 |
| Separate synthetic incidents | 5/6 | 5/6 | 5/6 | 5/6 | 6/6 |

In the new dataset, the model correctly escalated the paused outage while the rules recommended another Gateway check. When Gateway showed a charge and the seller had no trace, the rules correctly recommended contacting the merchant while the model escalated. The model's escalation in the outage cited Gateway unavailability and omitted the paused worker. The results describe these fixtures and do not measure operator time or escalation rates in production.

```sh
npm run build
npm run --silent eval:gateway -- --dataset gateway-incidents-v1 --model qwen2.5:0.5b
```

### Escalation after a paused Gateway outage

When automatic checks are paused and the latest lookup is unavailable, an unresolved purchase now calls for operator review. The recommendation requires both the polling flag and the failed lookup. If the latest lookup is pending, the rules request a manual check of the original authorization and cite the pause and pending result. A recorded charge with a retrievable trace still calls for recovery.

On `gateway-incidents-v1`, the rules improved from 5/6 to 6/6 for both actions and citation completeness. Local Qwen remained at 5/6 for actions and improved from 5/6 to 6/6 for citation completeness. The policy required escalation for the paused outage, so the citation gain reflects the changed requirement and the model's compliance. The model still escalated the case where the operator should contact the merchant about a missing trace.

### Cases with a choice of action

The evaluation now reports cases with one permitted action and cases with several possible actions. An unnecessary escalation is a recommendation to escalate or review a conflict when the expected action requires neither. Its rate uses all cases in the group whose labels require neither action. Recommendation coverage is reported alongside that rate. The fallback comparison assumes the operator uses an accepted model recommendation and uses the rule recommendation when the model is unavailable or its response is rejected.

On 2026-11-15, local Qwen2.5 0.5B produced the following results for cases with a choice. Each count uses all cases in its row as the denominator.

| Dataset | Correct rule actions | Correct model actions | Correct actions with fallback | Unnecessary rule escalations | Unnecessary escalations with fallback |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gateway-triage-v1` | 9/9 | 4/9 | 5/9 | 0/9 | 4/9 |
| `arc-recovery-v1` | 3/3 | 1/3 | 2/3 | 0/3 | 1/3 |
| `gateway-incidents-v1` | 3/3 | 2/3 | 2/3 | 0/3 | 1/3 |

The model also returned the expected action in all six cases where policy allowed only one action. The six unnecessary escalations in the table all passed validation, so falling back on missing or rejected responses did not prevent them. Examples include checking an unresolved payment by its original authorization, retrieving a trace from the seller, and asking the merchant to investigate a missing trace. These counts cover the evaluation fixtures, including multiple stages of the same Arc purchase. They do not measure production escalation rates or operator time.

### Optional evidence selection

The console displays one rule action with its required evidence. The model may add up to two saved facts. The evaluation compares those additions with the hand-labeled relevant facts for each case. The prior action selection experiment remains available in the evaluation command.

| Dataset | Accepted model responses | Relevant additional facts | Cases with a relevant addition | Mean model call time |
| --- | ---: | ---: | ---: | ---: |
| `gateway-triage-v1` | 12/12 | 0 | 0/12 | 310 ms |
| `arc-recovery-v1` | 3/3 | 1 | 1/3 | 227 ms |
| `gateway-incidents-v1` | 6/6 | 0 | 0/6 | 219 ms |

Local Qwen2.5 0.5B added one fact across 21 cases on 2026-11-15. In the Arc replay before the first Gateway lookup, it highlighted that the seller had saved the trace. This explains why recovery may be possible after the original authorization is checked. It does not resolve the payment status. The timings cover local model calls and validation. Operator review time was not measured.

```sh
npm run build
npm run --silent eval:gateway -- --dataset arc-recovery-v1 --support-rules --model qwen2.5:0.5b
```

### Timed operator pilot

With a local Ollama model running, assign roughly equal numbers of reviewers to groups A and B. Give each reviewer one run in an interactive terminal and save each report under a separate anonymous ID.

```sh
npm run --silent study:gateway -- --cohort A --model qwen2.5:0.5b > operator-A01.json
npm run --silent study:gateway -- --cohort B --model qwen2.5:0.5b > operator-B01.json
```

Each run has 12 distinct synthetic cases drawn from the two synthetic datasets, arranged in six pairs with the same expected action. Each reviewer sees one case from each pair with additional evidence selection enabled and the other with rules alone. The two groups see the same cases in the same order with opposite conditions. The terminal presents the same rule action, required facts, and saved evidence in both conditions. The assisted condition can also highlight additional facts selected by the model. The runner withholds case names, expected answers, and feedback until the session finishes.

Timing starts when the reviewer opens a case and stops after they submit the next action and supporting evidence. The report records the total time, model wait time, model status, and selected evidence. A decision passes when its action matches the label and it includes every required fact with no irrelevant references. The summary gives counts of correct decisions and median time among correct decisions in each condition. Model failures stay in the assigned assisted condition and are recorded so their effect can be examined. Keep failed and incorrect trials when analyzing accuracy.

The runner uses a terminal to reproduce the two evidence presentations. The pilot measures review in that setting. Browser console timings and actual operator results remain to be collected.

### Automated simulation

With Ollama running, replay both cohorts without terminal input.

```sh
npm run --silent study:gateway -- --simulate --model qwen2.5:0.5b > operator-simulation.json
```

The script submits the displayed rule action and its required citations. Assisted cases call the configured model. The JSON includes both cohorts and labels every report as `simulation`. Reported durations measure script and model execution. For a single cohort, add `--cohort A` or `--cohort B`. The command still emits the report if every model response is unavailable or rejected, and returns exit code 2 in that case.

### Critical evidence for follow-up

The `gateway-critical-evidence-v1` dataset uses six synthetic cases. Three have a labeled fact that can change the follow-up after the recommended action. Three controls have no labeled critical addition. Each method receives the same saved facts. The assisted result combines required rule citations with model additions accepted by the validator. Evidence labels are used for scoring only.

| Case | Critical fact | Follow-up it informs |
| --- | --- | --- |
| Paid response lost and the charge is unknown | The seller saved the trace | Retrieve the saved trace if the original authorization confirms a charge |
| Gateway confirms the charge and the buyer needs to recover the trace | The local journal is missing | Check accounting as well as recovering the trace |
| Gateway conflicts with a previously recorded charge | The local journal was already posted | Include the posted entry in the conflict review |

On 2026-11-15, Qwen2.5 0.5B accepted all six cases and returned only the required rule citations. Both configurations found 0/3 critical facts and displayed zero unrelated references. All six primary actions matched the labels under the rule policy. The model call added a mean of 364 ms locally. The rules remain the default. This replay measures evidence selection across six fixtures and contains no operator timing data.

```sh
npm run build
npm run --silent eval:gateway -- --dataset gateway-critical-evidence-v1 --support-rules --rules-only
npm run --silent eval:gateway -- --dataset gateway-critical-evidence-v1 --support-rules --model qwen2.5:0.5b
```

### Rules for critical follow-up evidence

The rule recommendation now cites a saved seller trace when the buyer still needs to check the original authorization and recover delivery if the charge is confirmed. It cites a missing journal for a confirmed charge on a purchase with a tracked budget. It also cites an existing journal when Gateway reports a conflict.

The six-case rules-only rerun found **3/3 critical facts**, compared with 0/3 before the change. All six actions and citation sets matched their labels, with zero unrelated references and no new references in the three controls. The other three datasets also matched all 21 action and citation labels. These results measure the rules on the replay fixtures.

## Multi-model comparison and per-model prompts

The triage call path now resolves a per-model profile instead of hardcoding one prompt. Profiles live in `src/gateway-triage-models.ts`. Each profile declares the choose-action and support-rules system prompts plus sampling options (temperature and token budget). A model not listed in the registry falls back to the default prompt, so adding a model is a registry entry — no change to the triage or evaluation call path.

The validation envelope is unchanged by any profile. The model still proposes only `action` and `citations`; the server enforces the JSON schema, rejects actions outside the permitted set, rejects citations outside the supplied facts, requires the action's required citations, and supplies the displayed explanation. A profile changes how the model proposes, never what the backend accepts.

### Per-model prompting

The first pass assumed "weak model gets a dictionary, stronger models get a principles prompt". That assumption was measured and rejected:

- A **principles** prompt ("prefer the most specific action, escalate only when…") collapsed the mid-size models to `escalate` — 1.5b picked escalation for 12/12 cases, and 3b scored 8/12 with four unnecessary escalations.
- A **dictionary** (one line per action with its trigger) is the correct base for every Qwen size tested.

The remaining per-model difference is a single line: how `escalate` is described.

| Model | Escalation line | Action accuracy | Unnecessary escalations |
| --- | --- | ---: | ---: |
| `qwen2.5:0.5b` | "…otherwise only when no other action fits" (last resort) | 12/12 | 0/9 |
| `qwen2.5:1.5b` | same last-resort line + a positive closing note | 9/12 | 3/9 |
| `qwen2.5:3b` | "ONLY when polling is paused and the latest lookup is unavailable" | 11/12 | 1/9 |

Measured on 2026-11-16 on an Apple Silicon Mac with Ollama, dataset `gateway-triage-v1`, temperature zero. Mean generation was 211 ms (0.5b), 403 ms (1.5b), 952 ms (3b).

Three findings worth carrying forward:

1. **A weak model fixates on whatever word is repeated.** Emphasizing "escalate is not a default" made 0.5b escalate every time; the plain dictionary without that sentence restores 12/12.
2. **The escalation boundary itself is per-model.** 0.5b needs the "last resort" framing; 3b needs an absolute "ONLY when". Sharing one escalation line cost 3b three points (11/12 → 9/12).
3. **1.5b retains a stubborn escalation bias** (three unnecessary escalations) that prompt wording alone did not remove. It is the weakest local choice for the choose-action task.

### Running the comparison

```sh
npm run build
npm run --silent eval:gateway -- --dataset gateway-triage-v1 --models qwen2.5:0.5b,qwen2.5:1.5b,qwen2.5:3b
```

The output reports the rule baseline and a `comparison` table with action accuracy, complete citation sets, citation precision, recommendation coverage, unnecessary escalation rate, and mean generation time per model. Models are evaluated serially so a local Ollama never loads several weights at once.

