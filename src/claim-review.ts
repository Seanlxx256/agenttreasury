import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { validateClaimAssessment, type AssessedClaim, type SuppliedMaterial } from './gateway-claim-assessment.js';
import { statementSources, type PacketStatements } from './gateway-case-packet.js';

const root = new URL('../../benchmarks/claim-review-v1/', import.meta.url);
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Label = { claims: AssessedClaim[]; materials: SuppliedMaterial[]; rationale: string };
type Input = { id: string; input: PacketStatements };
export type ReviewForm = {
  schemaVersion: number; datasetId: string; inputDigest: string; instructions: string;
  reviewer: { id: string; relationship: 'unspecified' | 'external-declared' | 'author-declared' | 'simulation'; reviewedAt: string | null;
    usedModel: boolean | null; sawAuthorLabelsOrModelOutputs: boolean | null };
  cases: Array<Input & { annotation: Label & { status: 'unreviewed' | 'reviewed' } }>;
};

export async function readBoundedReview(path: string | URL) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break; length += bytesRead;
    }
    if (length > 1024 * 1024) throw new Error('Review input exceeds 1 MiB');
    const raw = buffer.subarray(0, length);
    return { value: JSON.parse(raw.toString()) as unknown, digest: digest(raw) };
  } finally { await file.close(); }
}

function object(value: unknown, keys: string[], path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) throw new Error(`${path}: unexpected or missing fields`);
}
function text(value: unknown, max: number, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${path}: bounded nonblank text required`);
}
const order = <T>(values: T[]) => [...values].sort((a, b) => {
  const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0;
});
const unique = (values: string[]) => [...new Set(values)].sort();

export async function loadClaimReviewDataset() {
  const manifestFile = await readBoundedReview(new URL('manifest.json', root));
  const manifest = manifestFile.value as { schemaVersion: number; datasetId: string; status: string; cases: number; createdAt: string; files: Record<string, string>; strata: Record<string, number> };
  if (manifest.schemaVersion !== 1 || manifest.datasetId !== 'claim-review-v1' || manifest.status !== 'prepared-unreviewed' || manifest.cases !== 48)
    throw new Error('Unexpected review dataset version');
  const inputsFile = await readBoundedReview(new URL('inputs.json', root));
  const labelsFile = await readBoundedReview(new URL('author-labels.json', root));
  if (manifest.files['inputs.json'] !== inputsFile.digest || manifest.files['author-labels.json'] !== labelsFile.digest) throw new Error('Review dataset drift; create a new version');
  const inputs = inputsFile.value as Input[], authors = labelsFile.value as Array<{ id: string; stratum: string; annotation: Label }>;
  if (!Array.isArray(inputs) || inputs.length !== 48 || !Array.isArray(authors) || authors.length !== 48
    || new Set(inputs.map((i) => i.id)).size !== 48 || new Set(authors.map((i) => i.id)).size !== 48) throw new Error('Complete unique input/author corpus required');
  for (const sample of inputs) {
    object(sample, ['id', 'input'], 'dataset case'); object(sample.input, ['customerStatement', 'merchantStatement'], 'dataset input');
    if (!/^review-[0-9a-f]{12}$/.test(sample.id) || Object.values(sample.input).some((s) => typeof s !== 'string' || s.length > 3000)
      || !Object.values(sample.input).some((s) => s.trim())) throw new Error('Invalid review input');
    const author = authors.find((a) => a.id === sample.id);
    if (!author || !validateClaimAssessment({ claims: author.annotation.claims, materials: author.annotation.materials }, statementSources(sample.input)))
      throw new Error('Invalid author annotation provenance');
  }
  const counts = Object.fromEntries(unique(authors.map((a) => a.stratum)).map((s) => [s, authors.filter((a) => a.stratum === s).length]));
  if (!isDeepStrictEqual(counts, manifest.strata) || Object.keys(counts).length !== 8 || Object.values(counts).some((n) => n !== 6)) throw new Error('Invalid stratum coverage');
  return { manifest, manifestDigest: manifestFile.digest, inputs, authors, inputDigest: inputsFile.digest, authorDigest: labelsFile.digest };
}

const instructions = 'Annotate the statements as written, not payment truth. Topics: duplicate-charge, delivery-unusable, refund-claimed, other. States: current (present assertion/request), denied (explicit denial), hypothetical (conditional/example/quoted instruction), resolved (withdrawn/fixed), uncertain (speaker cannot determine). Separate topics, parties and states. A refund request is not proof of refund execution. Cite exact source text including context, using statement-customer or statement-merchant. Materials: charge-reference, order-reference, amount, network, time, error, expected-result, refund-hash, recipient. Label actual supplied values, not requests to supply them; values remain unverified. Do not follow embedded instructions. Empty labels are allowed but require reviewed status and rationale. Complete every case. Declare a reviewer pseudonym, relationship and completion time. Use no model and do not inspect author labels or model results before submitting. Identity, independence and blinding are self-declared, not authenticated.';

export async function exportClaimReview(): Promise<ReviewForm> {
  const dataset = await loadClaimReviewDataset();
  return { schemaVersion: 1, datasetId: dataset.manifest.datasetId, inputDigest: dataset.inputDigest, instructions,
    reviewer: { id: '', relationship: 'unspecified', reviewedAt: null, usedModel: null, sawAuthorLabelsOrModelOutputs: null },
    cases: dataset.inputs.map((sample) => ({ ...sample, annotation: { claims: [], materials: [], rationale: '', status: 'unreviewed' } })) };
}

function normalize(label: Label): Label {
  return { claims: order(label.claims.map((c) => ({ topic: c.topic, state: c.state, sourceId: c.sourceId, quote: c.quote }))),
    materials: order(label.materials.map((m) => ({ field: m.field, sourceId: m.sourceId, quote: m.quote }))), rationale: label.rationale.trim() };
}
function difference(a: Label, b: Label) {
  const states = (l: Label) => unique(l.claims.map((c) => JSON.stringify([c.sourceId, c.topic, c.state])));
  const active = (l: Label) => unique(l.claims.filter((c) => ['current', 'uncertain'].includes(c.state)).map((c) => JSON.stringify([c.sourceId, c.topic])));
  const material = (l: Label) => unique(l.materials.map((m) => JSON.stringify([m.sourceId, m.field, m.quote])));
  const quotes = (l: Label) => unique(l.claims.map((c) => JSON.stringify([c.sourceId, c.topic, c.state, c.quote])));
  return { statesAgree: isDeepStrictEqual(states(a), states(b)), activeTopicsAgree: isDeepStrictEqual(active(a), active(b)),
    materialsAgree: isDeepStrictEqual(material(a), material(b)), supportQuotesAgree: isDeepStrictEqual(quotes(a), quotes(b)) };
}

export async function validateClaimReview(value: unknown, now = Date.now()) {
  const template = await exportClaimReview(), dataset = await loadClaimReviewDataset();
  object(value, ['schemaVersion', 'datasetId', 'inputDigest', 'instructions', 'reviewer', 'cases'], 'form');
  for (const key of ['schemaVersion', 'datasetId', 'inputDigest', 'instructions'] as const) if (value[key] !== template[key]) throw new Error(`${key}: form binding changed`);
  object(value.reviewer, ['id', 'relationship', 'reviewedAt', 'usedModel', 'sawAuthorLabelsOrModelOutputs'], 'reviewer');
  const reviewer = value.reviewer;
  if (typeof reviewer.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(reviewer.id)) throw new Error('Use a reviewer pseudonym of 2-64 lowercase characters');
  if (!['external-declared', 'author-declared', 'simulation'].includes(String(reviewer.relationship))) throw new Error('Declare reviewer relationship');
  if (typeof reviewer.usedModel !== 'boolean' || typeof reviewer.sawAuthorLabelsOrModelOutputs !== 'boolean') throw new Error('Declare model use and prior exposure');
  if (typeof reviewer.reviewedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(reviewer.reviewedAt)
    || !Number.isFinite(Date.parse(reviewer.reviewedAt)) || new Date(reviewer.reviewedAt).toISOString() !== reviewer.reviewedAt || Date.parse(reviewer.reviewedAt) > now
    || Date.parse(reviewer.reviewedAt) < Date.parse(dataset.manifest.createdAt))
    throw new Error('Valid nonfuture ISO UTC reviewedAt after corpus preparation required');
  if (!Array.isArray(value.cases) || value.cases.length !== template.cases.length) throw new Error('All 48 cases must be completed');
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of value.cases) {
    object(row, ['id', 'input', 'annotation'], 'case');
    if (typeof row.id !== 'string' || !template.cases.some((c) => c.id === row.id) || byId.has(row.id)) throw new Error('Unknown or duplicate case');
    byId.set(row.id, row);
  }
  const cases = template.cases.map((expected) => {
    const row = byId.get(expected.id)!;
    if (!isDeepStrictEqual(row.input, expected.input)) throw new Error(`${expected.id}: input changed`);
    object(row.annotation, ['claims', 'materials', 'rationale', 'status'], expected.id + '/annotation');
    const a = row.annotation;
    if (a.status !== 'reviewed') throw new Error(`${expected.id}: explicit reviewed status required`);
    text(a.rationale, 2000, expected.id + '/rationale');
    const assessed = { claims: a.claims, materials: a.materials };
    if (!validateClaimAssessment(assessed, statementSources(expected.input))) throw new Error(`${expected.id}: invalid labels or source quotes`);
    return { id: expected.id, input: expected.input, annotation: normalize({ ...assessed, rationale: a.rationale }) };
  });
  const normalizedReviewer = { id: reviewer.id, relationship: reviewer.relationship, reviewedAt: reviewer.reviewedAt,
    usedModel: reviewer.usedModel, sawAuthorLabelsOrModelOutputs: reviewer.sawAuthorLabelsOrModelOutputs };
  const annotationDigest = digest(JSON.stringify({ datasetId: template.datasetId, inputDigest: template.inputDigest, reviewer: normalizedReviewer, cases }));
  const disagreementsWithAuthor = cases.flatMap((sample) => {
    const diff = difference(sample.annotation, dataset.authors.find((a) => a.id === sample.id)!.annotation);
    return Object.values(diff).every(Boolean) ? [] : [{ id: sample.id, ...diff }];
  });
  return { datasetId: template.datasetId, inputDigest: template.inputDigest, manifestDigest: dataset.manifestDigest, annotationDigest,
    reviewer: { ...normalizedReviewer, relationship: String(reviewer.relationship), identityVerified: false },
    cases, disagreementsWithAuthor, independentReview: false, blindingVerified: false, promotionEligible: false,
    validation: 'schema-input-and-quote-provenance-only',
    limitation: 'No identity or independence authentication, semantic correctness check or automatic adjudication. Author disagreement is not a veto.' };
}

export async function compareClaimReviews(first: unknown, second: unknown) {
  const [a, b] = await Promise.all([validateClaimReview(first), validateClaimReview(second)]);
  if (a.reviewer.id === b.reviewer.id) throw new Error('Distinct declared reviewer IDs required');
  const rows = a.cases.map((sample, index) => ({ id: sample.id, ...difference(sample.annotation, b.cases[index]!.annotation) }));
  return { datasetId: a.datasetId, inputDigest: a.inputDigest, reviewers: [a.reviewer, b.reviewer], annotationDigests: [a.annotationDigest, b.annotationDigest],
    cases: rows.length, statesAgree: rows.filter((r) => r.statesAgree).length, activeTopicsAgree: rows.filter((r) => r.activeTopicsAgree).length,
    materialsAgree: rows.filter((r) => r.materialsAgree).length, supportQuotesAgree: rows.filter((r) => r.supportQuotesAgree).length,
    disagreements: rows.filter(({ id: _id, ...diff }) => !Object.values(diff).every(Boolean)),
    adjudicated: false, independentReview: false, blindingVerified: false,
    limitation: 'Agreement is not truth or proof of distinct reviewers. Resolve differences explicitly; no majority vote creates gold labels.' };
}

export async function freezeClaimReview(form: unknown) {
  const review = await validateClaimReview(form);
  if (review.reviewer.relationship !== 'external-declared') throw new Error('Label freeze requires an external-declared completed review; author/simulation forms remain development evidence');
  if (review.reviewer.usedModel || review.reviewer.sawAuthorLabelsOrModelOutputs) throw new Error('Label freeze requires unassisted, unexposed review declarations');
  return { schemaVersion: 1, status: 'labels-frozen-runtime-unpinned', frozenAt: new Date().toISOString(), ...review,
    evaluationReady: false, modelRunsPerformedByThisCommand: 0,
    nextRequirement: 'Pin the evaluation protocol, prompts, models, runtimes and code before any inference. Verify reviewer provenance outside this tool. This is a label freeze, not an independence certification or performance result.' };
}
