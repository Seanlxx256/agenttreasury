# Stage 15 Annotation import and disagreement handling

Case-packet evaluation now accepts completed review forms, validates their binding
to the input corpus, compares reviewers and runs against the supplied labels. This
completes the review tooling; no external reviewer has completed or independently
validated this corpus as part of the implementation.

## Form contract

Export a fresh schema-version-2 form. Older Stage 13 exports remain historical
artifacts and are rejected by the importer: re-export rather than changing their
version number. The form binds the dataset ID, an input digest, exact case IDs,
statements and synthetic snapshots. Only annotation fields may be edited.

For every case fill `issues`, `requiredGapIds`, `rationale`, a lowercase reviewer
pseudonym, `reviewedAt` in ISO UTC with milliseconds, `status: "reviewed"`, and one
relationship: `external-declared`, `author-declared` or `simulation`. Use one reviewer
and relationship per form. Negative cases require explicit reviewed status and a
rationale even when both label lists are empty. Avoid personal identifiers.

Validation rejects missing/duplicate/foreign cases, changed inputs, fabricated or
foreign-source quotes, duplicate issues, unsupported topic/category enums, category
sets inconsistent with topics, blank rationale, invalid/future dates, mixed reviewer
identities, extra fields and files larger than 1 MiB. Canonical label digests survive
case/issue reordering. Exact quote membership is provenance, not semantic truth.
The caller cannot submit a trusted identity or promotion flag.

Differences from author labels are reported, not rejected. Two forms can be compared
when their input binding matches and their declared reviewer IDs differ. Topic/source
pairs, material categories and support quotes are compared separately. No automatic
majority, adjudicated answer or verified independence is created. Distinct pseudonyms
cannot prove distinct people. `independentReview` and `promotionEligible` remain false.

## Commands

Use a new output filename each time; existing reports are never overwritten.

```sh
npm run --silent eval:case-packets -- --export-review --output /tmp/reviewer-a.json
# A reviewer completes every annotation in reviewer-a.json.
npm run --silent eval:case-packets -- --validate-review --annotations /tmp/reviewer-a.json --output /tmp/reviewer-a-validation.json

# After another reviewer independently completes a separately exported form:
npm run --silent eval:case-packets -- --compare-review /tmp/reviewer-b.json --annotations /tmp/reviewer-a.json --output /tmp/review-differences.json

# Uses exactly the imported labels; they never enter the model prompt.
npm run --silent eval:case-packets -- --rules-only --annotations /tmp/reviewer-a.json --output /tmp/reviewed-rules.json
# Optional local-model run:
npm run --silent eval:case-packets -- --model qwen2.5:3b --annotations /tmp/reviewer-a.json --output /tmp/reviewed-model.json
```

Imported labels, declared provenance, raw-file and canonical annotation digests, and
disagreements are retained in the plan/report. Changes after planning stop execution.
The corpus remains the known development corpus even when labels come from another
person; relabelling it does not make the inputs unseen or held out. Reviewer files
are never executed and contain no URLs to fetch. The importer does not write payment
state or send messages to reviewers.

## Validation

Tests exercise schema/input tampering, source-bound quotes, explicit negative labels,
reviewer/date fields, harmless JSON ordering, author disagreement, two-reviewer
comparison, label injection boundaries and mid-plan changes. Real CLI tests export
synthetic completed forms in a temporary directory, validate/compare them, run a
rules-only evaluation and reject overwrite/oversized inputs. These tests label their
reviewer relationship `simulation`; they are not evidence of independent review.

See the final acceptance report for the current complete regression count. This
stage needs no database migration or running model. The exported blank form in the
final acceptance artifacts is ready for an actual reviewer, with no completed labels.
