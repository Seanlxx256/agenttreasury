# Agent capability and measured increment

The project has implemented agent-facing payment controls, read-only investigation
and reviewable case preparation. It has not demonstrated a stable operational
advantage from the optional model. Deterministic controls and explicit operator
review remain the execution boundary.

## Evidence by protocol

| Experiment | Observed result | What it supports |
| --- | --- | --- |
| Earlier extraction and pattern development sets | Some paraphrases improved over keyword controls; prompts and labels were developed together | A development hypothesis, not production generalization; historical logs remain in [triage evaluation](gateway-triage-evaluation.md) |
| Stage 4 contextual exception benchmark | Neither measured model passed the candidate gates | Negation, stale claims and instruction-bearing text need stronger validation; [protocol/results](stage-4-exception-evaluation.md) |
| Stage 9 multi-step V2 investigation | Adaptive rules: 8/8 supported outcomes; Qwen 3B: 1/8, despite 5/8 matching conclusion classes | Correct-looking conclusions can lack required evidence; [captured experiment](stage-9-investigation-dialogue.md) |
| Stage 13 case preparation | Topic matches 4/12 template, 5/12 assisted; material-category matches 5/12 in both | One paraphrase recovery does not establish stable workflow value; [paired run](stage-13-case-packet-evaluation.md) |
| Stage 14 context holds | 6/12 known development cases held; 4/12 topic sets matched without review requirement | A conservative review boundary, not improved autonomous accuracy; [scope/results](stage-14-case-packet-context.md) |
| Stage 15 annotation tooling | Input/version/quote validation, imported labels and reviewer disagreement comparison | Enables future review; identities and independence remain unverified |
| Subsequent structured-claim development | Current topic/source sets: context rules 7/12, previous 3B adapter 4/12, structured 3B adapter 8/12; all states 6/12 | A narrow development gain, not default promotion or generalization; [results and implementation](ai-capability-hardening.md) |
| Material-parser replay after inspecting that run | Model found 0/13 fields; deterministic parser found 13/13 on the same known examples | Workflow engineering gain, explicitly not model accuracy or independently measured efficiency |

Protocols use different datasets and scoring rules. Do not combine these figures
into a single accuracy trend, omit failed model attempts, or reuse a development
case as unseen evaluation. Matching quotes establishes source membership, not truth.
The current packet workflow retains raw candidate evidence and exposes context holds
rather than crediting abstention as an autonomous success.

## What can be claimed now

The system restricts model inputs/outputs, binds evidence to a request and source,
records failures, and protects execution with deterministic policy checks. Its
operator workflow saves revisions and separates claims from local facts. The latest
full acceptance is linked from [the portfolio handoff](stage-16-portfolio-acceptance.md).

Client timing is a declared display-to-submit interval with idle time, not verified
human effort. Simulations are kept separate. A completed annotation form does not
prove its reviewer is independent or its labels correct. Independently reviewed new
cases and controlled human evaluation remain necessary before claiming reduced
review rate, better business outcomes or lower operating cost.

## Next use of the tooling

Export a blank form, have an actual reviewer complete it, and use [Stage 15 commands](stage-15-annotation-import.md)
to validate and compare it. Imported labels remain separate from author labels;
disagreements require explicit adjudication outside the current tool. A second
reviewer's declared ID alone does not authenticate a second person. Follow the
[Stage 12 study protocol](stage-12-case-packet-effort.md) for any human-efficiency claim.
No new mandatory implementation milestone is implied by these external evidence needs.
