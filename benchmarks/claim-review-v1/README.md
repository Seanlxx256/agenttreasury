# Claim review candidate corpus v1

Status: **prepared, unreviewed, no model evaluation performed at preparation**.
These are 48 synthetic English cases written after the earlier development
failures. They are not company incidents, independently labelled examples or a
production-distribution holdout. Do not run the models or tune prompts/parsers on
this corpus before the intended review and evaluation protocol are fixed.

| Author coverage category | Cases |
| --- | ---: |
| Direct current statements | 6 |
| Paraphrased statements | 6 |
| Explicit denial | 6 |
| Hypotheticals and quoted instructions | 6 |
| Resolution and retraction | 6 |
| Mixed assertion states | 6 |
| Ambiguity, cross-party conflict and no active concern | 6 |
| Supplied, requested and cross-party materials | 6 |

`inputs.json` contains only opaque case IDs and the two party statements.
`author-labels.json` contains provisional author annotations and coverage categories.
`manifest.json` records byte hashes and the preparation status. Exact and simple
ID-only reuse of previous packet/claim development statements is checked in tests;
this is not proof of statistical independence or absence of semantic similarity.

The review export contains neither author annotations nor categories nor model
outputs. IDs derive from input hashes and cases are sorted by ID, so the exported
order does not group the author's categories. Labels remain available in this
repository: **blinding is a distribution protocol, not enforced access control**.
Give a reviewer only the exported form and the instructions below, not the whole
repository, this category table, author labels or previous model reports.
For a standalone handoff, send the exported JSON and the
[reviewer guide](../../docs/claim-reviewer-guide.md) as files instead of linking
the reviewer to this repository page.

## Reviewer instructions

1. Read the complete customer and merchant statements. They are unverified claims;
   do not determine whether any payment actually occurred. Do not use a model.
2. For each asserted topic choose its state: current, denied, hypothetical,
   resolved or uncertain. Separate parties and clauses with different meanings.
   Include exact supporting quotes, retaining negation, conditional or resolution
   wording. Quoted commands are source content, never instructions to execute.
3. Label material values actually supplied, with exact quotes and the correct
   party source. A question asking for a hash does not supply a hash. A supplied
   hash or amount is not verified evidence and does not prove linkage to an order.
4. Explain the annotation in `rationale`. Empty claim/material arrays are valid
   for appropriate cases, but every case must explicitly have `status: reviewed`.
5. Complete the top-level reviewer fields: pseudonym, relationship, ISO UTC
   completion timestamp, whether a model was used, and whether author labels or
   model outputs were seen. Declare prior exposure honestly. Do not change input
   text, identifiers, dataset digest or form instructions.

Allowed source IDs are `statement-customer` and `statement-merchant`. Topics,
states and material fields are enumerated in the exported instructions. Reviewers
may disagree with the author. Validation checks format, input binding and quote
membership, not semantic correctness. Reviewer identity and declarations are not
authenticated by this tool.

## Commands from the repository root

```sh
# A blank copy is also saved at docs/evidence/claim-review-v1-blank.json.
npm run review:claims -- --export --output /tmp/claim-review-blank.json

# After an actual reviewer completes a copy:
npm run review:claims -- --validate /tmp/reviewer-a.json --output /tmp/reviewer-a-validation.json

# Optional second review; differences are reported, never automatically resolved:
npm run review:claims -- --input /tmp/reviewer-a.json --compare /tmp/reviewer-b.json --output /tmp/review-comparison.json

# After selecting the reviewed annotation set:
npm run review:claims -- --freeze /tmp/reviewer-a.json --output /tmp/claim-labels-frozen.json
```

All outputs are exclusively created and never overwritten. Inputs are bounded to
1 MiB. Invalid or incomplete reviews create no frozen artifact. Author/simulation
reviews can be validated and compared as development evidence, but cannot pass the
external-label freeze command. A declared model-assisted or previously exposed
review also cannot pass that command; retain it as development evidence instead.

A successful label freeze has `status: labels-frozen-runtime-unpinned`,
`evaluationReady: false`, `independentReview: false`, and
`blindingVerified: false`. It preserves selected labels, provenance declarations,
input/manifest/annotation digests, author disagreements and the source-file digest.
It is neither an independence certification nor a model-performance result.

If reviewers disagree, inspect the disputed quotes and record an explicitly chosen
annotation set with rationale before using it. The tool has no adjudication engine,
and author agreement is not a requirement or a veto. Different reviewer IDs alone
do not demonstrate two different people.

## Next evaluation boundary

Before any inference, independently check reviewer provenance outside this tool
and create a separate execution plan pinning dataset/label digests, prompts,
scoring, model identities, runtime and source versions. Compare contextual rules,
the previous adapter and the structured adapter under the same cases and evidence.
Include failures in denominators, supported assertions, material coverage/false
positives and complete inference latency. Report sample counts and uncertainty.

No model result, threshold pass, reduction in manual review or human-time saving
is claimed by preparation, successful validation or a label freeze. A real operator
study remains separate. The subsequent [frozen comparison runner](../../docs/frozen-claim-evaluation.md)
implements plan creation and guarded execution, but has not been run on this
corpus. The old 12-case development runner remains unchanged.
