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
