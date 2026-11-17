# Stage 14: context holds and explicit candidate review

Case packets now screen candidate topics before generating targeted follow-up
questions. The change responds to the Stage 13 denial, retraction and embedded
instruction failures. It preserves the raw rule/model candidates and source text;
it does not certify any statement as true, false, current or resolved.

## Behavior

- English cues for possible negation, hypotheticals, retraction/resolution and
  quoted instructions trigger a **whole-source hold**. Exact cue text, source ID
  and offset are stored. A positive complaint in the same source can also be held;
  the operator must read the complete source rather than rely on keyword scope.
- When the model returns accepted output, differences between rule and model
  `(source ID, topic)` pairs are visible and held. Agreement across different
  parties is not agreement on the same claim. Disabled, unavailable and rejected
  model responses are not interpreted as evidence that a topic is absent.
- Old model interpretations cannot silently rebind to refreshed dispute text.
  Quotes missing from the current source, or a changed source since model inference,
  remain visible but are held. Original model source text stays in the report.
- Eligible candidates remain unverified. They alone determine initial selected
  topics. If any context needs review, the merchant inquiry text is withheld and
  `reviewRequired` is true. No message is sent by this workflow.
- The operator can explicitly select current topics, including a held topic, and
  save a revision with the existing required rationale. This creates the requested
  draft; it does not remove context signals, verify assertions, close a case or
  execute a financial action. Financial records remain identical.

A source saying "No duplicate charge occurred, but the report is unusable" holds
both buyer topics conservatively. A separate merchant refund claim can remain an
eligible unverified candidate, but it cannot clear the buyer's review requirement.
A legitimate paraphrase found only by a model is also held for explicit review.
This favors reviewability over automatic coverage and may increase manual work.

## UI, persistence and compatibility

The console shows the context cues, held candidates and rule/model disagreements.
Held topics are not automatically checked. A clear warning says that held does not
mean false. Original facts, party statements and model interpretations remain
separate. Existing operator permissions and append-only version checks still apply.

New reports contain `candidateReview`, `selectedTopics`, `topicSelectionSource`
and `merchantInquiryDraft.reviewRequired`. Topic-edit telemetry compares against
saved selections for new reports, rather than counting every raw candidate as an
operator-selected topic. Older reports retain their original shape and history;
the legacy fallback for their edit comparison remains the original candidate union.

Old packets are not rewritten on read. The new console labels a legacy packet as
unscreened and leaves unreviewed legacy candidates unchecked. Previous explicit
operator selections remain visible. Saving an updated revision applies current
screening and records the operator's selections. Users should reload the console
and restart the API to use the new code. Schema version remains 40; no migration,
existing user database update or service restart was performed during implementation.

## Scope and limitations

This is a deterministic English heuristic and review policy, not a semantic model
improvement or a complete prompt-injection defense. Quotation marks can hold an
otherwise valid complaint; unrecognized wording, foreign languages, sarcasm or
complex scope can escape detection. A source without a cue is not independently
verified. Rules and models agreeing is not proof of correctness.

The application preserves all candidate evidence so an operator can correct both
false positives and false negatives. Existing human review supplies topic selection,
not new authority over payments. No private keys, balances, settlement, refund
execution or recipient policy is touched by this change.

## Evaluation protocol change

The paired evaluator now uses `case-packet-development-v2-context-review`. It reports
the raw candidate score, eligible-topic score, review requirement and candidate
reasons separately. Aggregate output adds `heldForReviewCases` and
`exactTopicSetsWithoutReview`. An empty eligible topic set on a held negative case
must not be interpreted as a successful autonomous diagnosis or zero human effort.

The original Stage 13 captured report remains unchanged. Its v1 union workflow and
its hashes describe that historical implementation. Current CLI runs use v2; the
v1 source is available in commit `ddebe79`. The same twelve development examples
have now informed implementation, so replay is not unseen evaluation or evidence
of generalization. No fresh model-quality or human-time improvement is claimed.

The [rules-only replay](evidence/stage-14-context-rules.json),
[manifest](evidence/stage-14-context-rules.json.plan.json) and
[case journal](evidence/stage-14-context-rules.json.cases.jsonl) record current
behavior without network calls or model inference. Newly authored regression
examples additionally cover contraction and postposed negation, mixed complaints,
source-scoped disagreement, stale model evidence and explicit operator override.
These are developer tests, not independently reviewed benchmark cases.

The rules-only replay holds **6/12** cases and matches the topic set without a
review requirement on **4/12**. Eight eligible topic sets match annotations in
total, but four of those are held cases and are not autonomous successes. Missing
question categories total five, illustrating the coverage cost of conservative
holds. The gate has not improved the underlying rule classifier.

## Validation and next step

The full suite passed **262/262**, zero failures or skips, in approximately 31.4
seconds excluding build. The final legacy-console refinement was also checked with
the focused console suite (**9/9 passed**). `git diff --check` passed. Database integration verifies
that a held packet can become an explicitly selected draft while financial tables
and the original historical version remain unchanged.

Next, add validated annotation-import support, then obtain independent annotation
review and a separate evaluation set for the
context policy, measuring both missed current complaints and unnecessary review
holds. Test paraphrase recovery and conflict handling under that protocol before
considering model enablement. Actual operator-time effects still require the
controlled study described in Stage 12.
