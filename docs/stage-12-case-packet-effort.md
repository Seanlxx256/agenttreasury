# Stage 12: review effort instrumentation and evaluation protocol

The operator workflow now records descriptive review effort inside each append-only
packet revision. The console exposes **View review effort** for the selected
request. This is measurement infrastructure, not evidence that the optional model
saves time. No new model score or human study result is claimed.

## Recorded measurements

| Field | Source and meaning |
| --- | --- |
| Topics added/removed | Server comparison against the previous selected topics, or initial candidates on first review. These are edits, not validated model errors. |
| Supplements added | Server count of newly appended material, not the cumulative material carried forward. |
| Changed local records | Server count of added, removed or changed records between bounded snapshots. A window eviction can count as removal. |
| Review phase | First operator review versus subsequent follow-up, derived from the parent packet. |
| Model name/status | The saved model interpretation, including disabled, rejected and unavailable states. Review does not rerun inference. |
| Declared origin | `interactive-declared`, `simulation-declared`, or `unclassified` when omitted. This is not authenticated human provenance. |
| Elapsed time | Optional client-reported milliseconds from the latest review form display to submission. Includes idle time; excludes initial statement entry, packet generation and save latency. |

The console uses its monotonic browser clock. Reloading or switching to a new
packet starts a new display interval. Unsubmitted work, earlier intervals and
failed attempts are not a complete activity log. Sessions longer than one hour
have a null duration rather than a fabricated cap; missing durations are never
zero-filled. Shared console role tokens do not identify individual reviewers,
and browser automation can imitate an interactive client. No verified human-work
metric is inferred from this telemetry.

## API and persistence

The existing revision endpoint accepts an optional, closed `timing` object:

```json
{
  "expectedPacketId": "42",
  "topics": ["delivery-unusable"],
  "note": "The customer clarified the reported failure.",
  "supplements": [],
  "timing": { "origin": "simulation-declared", "elapsedMs": 1200 }
}
```

Use `simulation-declared` for scripts, fixtures and automated runs. Interactive
console submissions declare `interactive-declared`. Existing callers can omit
`timing`; they are stored as `unclassified` with a null duration. The server rejects
negative, fractional or over-one-hour values, unknown origins and extra fields.
Null duration is permitted. The client cannot submit topic counts, model status,
review phase or a verified-human label. The API's existing authentication, version
checks and append transaction apply to the measurements too. A stale retry creates
neither a new packet nor a new counted review.

`GET /finance/gateway-purchases/:id/case-packet/effort` returns an authenticated,
`no-store` summary for one request. It selects only the latest 200 review revisions
and their measurement objects, with explicit truncation and oldest/newest packet
IDs. It does not expose statement excerpts, notes, references, tokens or signatures.
It does not claim whole-project statistics.

Groups remain separate by declared origin, review phase, model name and model
status. Each includes saved/timed/untimed counts, median elapsed milliseconds,
topic edits, supplements added and reviews with changed records. Initial packets
are not counted as reviews. Older revisions without instrumentation are reported
as `unmeasuredReviews` instead of treated as fast or zero-edit examples. Empty or
untimed groups have no median. Rejected model outputs never enter the ready group;
a follow-up inheriting model output never counts as another first-review task.

The data lives inside the existing immutable report JSON, so no new database
migration is required; schema version remains 40. Restart the API to load the new
server code and reload the console for browser instrumentation. No running user
service or existing database was modified during implementation.

## Evaluation protocol before an efficiency claim

The following is the protocol for a later controlled evaluation, not a completed
study. Passive request-level telemetry cannot replace it.

1. Prepare separate payment-exception cases covering direct claims, paraphrases,
   negation, ambiguous refund claims and evolving local evidence. Independently
   label required follow-up materials, supported assertions and acceptable topics.
   Keep a development set separate from a frozen evaluation set and record dataset,
   prompt, model and code identities. The existing Stage 10 smoke examples are
   development material and cannot become unseen evaluation cases.
2. Compare template-only preparation with the same workflow plus actual optional
   model extraction. Keep backend evidence access and review permissions identical.
   Record failed/rejected model attempts as assigned-model cases, not as template
   successes. Use an explicit study assignment rather than infer treatment from
   a model status after the fact.
3. Counterbalance equivalent but distinct cases across operators to reduce learning
   effects; do not show the same answer to an operator twice. Record assignment,
   operator consent/identity handling, completion, abandonment and model latency in
   a dedicated study artifact. Existing shared role tokens are insufficient for
   operator-level attribution.
4. Score unsupported assertions, missing required material and accepted topic
   selection against independently reviewed annotations. Measure end-to-end
   preparation time separately from this display-interval timer. Report review edits
   as effort, not semantic correctness. Include failures and non-completions in the
   denominator; publish sample sizes and uncertainty, not just successful examples.
5. Claim value only if the assisted workflow preserves quality while reducing actual
   human preparation effort under the preregistered comparison. An automated run can
   check schema, counting and safety but cannot demonstrate human time savings.

## Validation and limits

`npm test`: **238/238 passed**, no failures or skips, approximately 31.3 seconds
excluding build. `git diff --check` passed. Existing frozen evaluation checks
continue to pass.

Automated tests cover grouping separation, medians and missing values, client
input rejection, server-derived counts, one-count successful revision semantics,
unchanged financial state, authentication, request isolation, the 200-row window,
old unmeasured records, and console timer reset/long-session behavior. Synthetic
tests intentionally exercise both declared origins; their interactive label is
not presented as evidence of a human study. UI checks use the repository's DOM
harness rather than a visual browser test.

Model extraction remains disabled by default. This stage adds no external messages,
wallet calls, refund actions, chain verification, dataset-independent quality score
or claim of production readiness. Next: create the isolated comparison harness and
independently review its case labels before collecting any human-effectiveness result.
