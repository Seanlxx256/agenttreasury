# Batch investigation review packet v1

This is a versioned packet for independent annotation of evidence gaps and
conflicts, not a blind model benchmark or production incident dataset.

- Two cases reproduce captured project evidence: a modern complete field linkage
  and a legacy request missing original authorization fields.
- Ten synthetic variations alter one evidence family at a time. They are not
  observed incidents and are strongly correlated with the modern base sample.
- `inputs.json` contains only case IDs and investigative inputs. `labels.json`
  contains single-author proposed conclusions, required reads, evidence paths
  and rationales. `provenance.json` distinguishes captured cases from mutations.
- `manifest.json` binds the files and source archives with SHA-256. These are
  local integrity hashes, not external attestations. Corrections after review
  require a new version; do not silently refreeze this packet.

The task is to distinguish `corroborated`, `incomplete` and `conflict`, select
read-only checks and identify evidence supporting the conclusion. Corroboration
is not signature verification, cryptographic nonce inclusion, payee entitlement,
permission to move money or automatic case closure. The packet focuses on
request-field, journal, Gateway-reference and batch consistency; it does not
measure delivery quality, routing, key custody or human operations time.

Export inputs and blank annotations for a reviewer without exposing proposed
labels or scenario-construction notes:

```sh
node scripts/export-batch-investigation-review.mjs > /tmp/batch-review.json
```

Independent review is pending. No model had been evaluated when this packet was
created; the immutable manifest records that checkpoint. A subsequent
[exploratory protocol](../batch-investigation-eval-v1/README.md) records model runs
separately without rewriting the original packet or its creation metadata.
Regression tests check proposed conclusion consistency and evidence-path
existence; their agreement is not agent accuracy, an independent gold standard
or measured business ROI. Do not use the repeated variants as independent
statistical samples or tune on these labels and call later results blind.
Before comparing rules and an agent, review the labels, preregister the output
schema, citation criteria and scoring, and freeze the runtime/model settings.
