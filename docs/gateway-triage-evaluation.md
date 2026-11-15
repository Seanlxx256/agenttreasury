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
