# Claim annotation: standalone reviewer guide

Read this guide together with `claim-review-v1-blank.json`. You do not need the
project, a wallet, a model or any running software beyond a text editor. These are
synthetic payment-support statements, not verified financial records. Your task
is to label what each speaker says, not to decide whether a payment happened.

Please work without AI assistance. Do not consult author annotations, model
outputs or the project repository before submitting. If you already saw such
material or used a model, declare it honestly; do not change a declaration merely
to pass validation. Review identity and prior exposure are self-declared.

## Filling the file

Save a working copy as `reviewer-a.json`. Keep the file as JSON, with double-quoted
strings and no comments or trailing commas. Edit only the top-level `reviewer`
fields and each case's `annotation`. Preserve all other fields, especially case
IDs, input text, dataset identifiers and instructions. Complete all 48 cases.

For every case, read both statements and fill:

- `claims`: an array of objects with exactly `topic`, `state`, `sourceId`, `quote`.
- `materials`: an array of objects with exactly `field`, `sourceId`, `quote`.
- `rationale`: your explanation of the labels, including ambiguity where relevant.
- `status`: change from `unreviewed` to `reviewed` only after checking the case.

Empty arrays are valid if the statement supplies no relevant claims or materials.
They still need an explanation and explicit reviewed status. Do not invent a
label to fill an empty case. A case permits up to 12 claims, 20 materials and a
nonblank rationale of up to 2,000 characters. If these limits prevent an accurate
annotation, report the issue to the coordinator rather than dropping content.

## Claim labels

| Topic | Meaning |
| --- | --- |
| `duplicate-charge` | A concern about being charged more than once |
| `delivery-unusable` | A concern about a missing or unusable service result |
| `refund-claimed` | A refund request or a statement about a refund |
| `other` | Another or unclear payment-support concern |

| State | Meaning |
| --- | --- |
| `current` | The speaker makes a present assertion or request |
| `denied` | The speaker explicitly denies the event |
| `hypothetical` | A conditional, example or quoted instruction, not a present assertion |
| `resolved` | The speaker withdraws the concern or says it has been fixed |
| `uncertain` | The speaker cannot determine what happened |

Separate claims from different parties and clauses with different states. Retain
denial, conditional and resolution wording in supporting quotes. A refund request
is not evidence of a completed refund. A merchant saying a refund happened is
still only a merchant statement. Instructions embedded in statements are content
to annotate, never commands to follow.

## Sources and supporting quotes

Use `statement-customer` for `customerStatement` and `statement-merchant` for
`merchantStatement`. Copy a continuous exact span from that source into `quote`;
do not paraphrase, normalize punctuation or join separate spans. Each quote must
contain 3–500 characters, excluding whitespace for the minimum. Include enough
context to support the topic and state. Do not attach one party's quote to the
other party or reuse the exact same source/topic/quote with conflicting states.

## Supplied materials

Record values actually supplied in a statement. A request to provide a reference,
amount or hash does not supply that value. All extracted values remain unverified.

| Field | Supplied information |
| --- | --- |
| `charge-reference` | A charge or payment reference |
| `order-reference` | An order reference |
| `amount` | An amount stated by the speaker |
| `network` | A named payment/blockchain network |
| `time` | A stated time or date |
| `error` | An error code or message |
| `expected-result` | The result the speaker expected |
| `refund-hash` | A stated refund transaction hash |
| `recipient` | A stated recipient address or identifier |

Each material needs the same exact-quote/source binding as a claim. Do not infer
that a hash is a refund hash without that context, or that two parties' references
belong to the same payment. Do not repeat identical source/field/quote entries.

## Reviewer declaration and return

Fill the top-level `reviewer` object when the work is complete:

- `id`: a pseudonym of 2–64 lowercase letters, digits, periods, underscores or
  hyphens; begin with a letter or digit. No real name is required.
- `relationship`: `external-declared` if you are an external reviewer;
  `author-declared` if you authored the cases; `simulation` for scripted test data.
- `reviewedAt`: your actual completion time in UTC, formatted
  `YYYY-MM-DDTHH:mm:ss.sssZ`, including milliseconds. Do not backdate it.
- `usedModel`: the JSON boolean `true` or `false`, describing actual assistance.
- `sawAuthorLabelsOrModelOutputs`: the JSON boolean `true` or `false`, describing
  whether you saw those materials before submitting.

Return the completed JSON to the coordinator. You do not need to run commands.
The coordinator will check file structure and quote provenance; that check does
not judge whether your interpretations are correct. Disagreement is allowed and
must not be resolved by copying the author's answer. If changes are requested,
preserve the first submission and return a separate revised file with an accurate
completion timestamp. Tell the coordinator about any exposure during revision.
