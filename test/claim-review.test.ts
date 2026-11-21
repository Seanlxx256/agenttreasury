import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exportClaimReview, loadClaimReviewDataset, validateClaimReview, compareClaimReviews, freezeClaimReview, readBoundedReview, type ReviewForm } from '../src/claim-review.js';
import { claimAssessmentCases } from '../src/claim-assessment-cases.js';
import { packetEvaluationCases } from '../src/case-packet-evaluation-cases.js';

// Synthetic fixtures only. The external-declared branch below tests the declared
// provenance gate, not an actual reviewer or independent validation result.
async function completed(id = 'fixture-a', relationship: ReviewForm['reviewer']['relationship'] = 'simulation') {
  const form = await exportClaimReview(), dataset = await loadClaimReviewDataset();
  form.reviewer = { id, relationship, reviewedAt: new Date().toISOString(), usedModel: false, sawAuthorLabelsOrModelOutputs: relationship !== 'external-declared' };
  for (const row of form.cases) row.annotation = { ...structuredClone(dataset.authors.find((a) => a.id === row.id)!.annotation), status: 'reviewed' };
  return form;
}

test('48 prepared cases cover eight strata and avoid exact or ID-only reuse of earlier packet inputs', async () => {
  const dataset = await loadClaimReviewDataset(); assert.equal(dataset.inputs.length, 48);
  assert.deepEqual(Object.values(dataset.manifest.strata), Array(8).fill(6));
  const normalize = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z# ]/g, '').replace(/\s+/g, ' ').trim();
  const previous = new Set([...claimAssessmentCases(), ...packetEvaluationCases()].flatMap((s) => Object.values(s.input)).filter(Boolean).map(normalize));
  for (const sample of dataset.inputs) for (const text of Object.values(sample.input).filter(Boolean)) assert.ok(!previous.has(normalize(text)));
  assert.equal(new Set(dataset.inputs.map((s) => JSON.stringify(s.input))).size, 48);
});

test('review export contains no author labels, strata, model output or prefilled answers', async () => {
  const form = await exportClaimReview();
  assert.deepEqual(form.reviewer, { id: '', relationship: 'unspecified', reviewedAt: null, usedModel: null, sawAuthorLabelsOrModelOutputs: null });
  for (const row of form.cases) {
    assert.deepEqual(Object.keys(row).sort(), ['annotation', 'id', 'input']);
    assert.deepEqual(row.annotation, { claims: [], materials: [], rationale: '', status: 'unreviewed' });
    assert.deepEqual(Object.keys(row.input).sort(), ['customerStatement', 'merchantStatement']);
  }
  assert.ok(!JSON.stringify(form).includes('stratum'));
  assert.deepEqual(Object.keys(form).sort(), ['cases', 'datasetId', 'inputDigest', 'instructions', 'reviewer', 'schemaVersion']);
  assert.deepEqual(JSON.parse(await readFile(new URL('../../docs/evidence/claim-review-v1-blank.json', import.meta.url), 'utf8')), form);
  await assert.rejects(validateClaimReview(form), /reviewer pseudonym/);
});

test('completed review normalizes order and keeps simulation explicitly unverified', async () => {
  const form = await completed(); const first = await validateClaimReview(form);
  const reordered = structuredClone(form); reordered.cases.reverse();
  reordered.reviewer = { sawAuthorLabelsOrModelOutputs: form.reviewer.sawAuthorLabelsOrModelOutputs, usedModel: form.reviewer.usedModel,
    reviewedAt: form.reviewer.reviewedAt, relationship: form.reviewer.relationship, id: form.reviewer.id };
  for (const row of reordered.cases) { row.annotation.claims.reverse(); row.annotation.materials.reverse(); }
  assert.equal((await validateClaimReview(reordered)).annotationDigest, first.annotationDigest);
  assert.equal(first.cases.length, 48); assert.equal(first.disagreementsWithAuthor.length, 0);
  assert.equal(first.independentReview, false); assert.equal(first.reviewer.identityVerified, false); assert.equal(first.promotionEligible, false);
  assert.ok(first.cases.some((row) => !row.annotation.claims.length));
});

test('changed inputs, schema, missing cases, duplicate cases and incomplete negatives are rejected', async () => {
  const base = await completed();
  const mutations: Array<(f: ReviewForm) => void> = [
    (f) => { f.inputDigest = 'changed'; }, (f) => { f.schemaVersion = 2; },
    (f) => { f.cases[0]!.input.customerStatement += ' changed'; }, (f) => { f.cases.pop(); },
    (f) => { f.cases[1] = structuredClone(f.cases[0]!); }, (f) => { f.cases[0]!.annotation.status = 'unreviewed'; },
    (f) => { f.cases[0]!.annotation.rationale = ' '; }, (f) => { f.reviewer.reviewedAt = '2099-01-01T00:00:00.000Z'; },
    (f) => { f.reviewer.reviewedAt = '2000-01-01T00:00:00.000Z'; },
  ];
  for (const mutate of mutations) { const value = structuredClone(base); mutate(value); await assert.rejects(validateClaimReview(value)); }
  await assert.rejects(validateClaimReview({ ...base, independentReview: true }), /unexpected/);
});

test('invented support, sources, states, materials and contradictory duplicates cannot pass validation', async () => {
  const base = await completed(); const index = base.cases.findIndex((row) => row.annotation.claims.length);
  for (const edit of [
    (c: Record<string, unknown>) => { c.quote = 'not present anywhere'; },
    (c: Record<string, unknown>) => { c.sourceId = 'journal'; },
    (c: Record<string, unknown>) => { c.state = 'paid'; },
    (c: Record<string, unknown>) => { c.execute = 'refund'; },
  ]) {
    const changed = structuredClone(base); edit(changed.cases[index]!.annotation.claims[0]!);
    await assert.rejects(validateClaimReview(changed), /labels or source quotes/);
  }
  const duplicate = structuredClone(base); duplicate.cases[index]!.annotation.claims.push({ ...duplicate.cases[index]!.annotation.claims[0]!, state: 'uncertain' });
  await assert.rejects(validateClaimReview(duplicate), /labels or source quotes/);
  const materials = structuredClone(base); materials.cases[index]!.annotation.materials.push({ field: 'refund-hash', sourceId: 'statement-merchant', quote: 'fabricated hash' });
  await assert.rejects(validateClaimReview(materials), /labels or source quotes/);
});

test('author disagreements are allowed, reviewer comparisons remain unresolved, and IDs do not certify people', async () => {
  const first = await completed('fixture-a'), second = await completed('fixture-b');
  const row = second.cases.find((c) => c.annotation.claims.length)!;
  row.annotation.claims[0]!.state = row.annotation.claims[0]!.state === 'uncertain' ? 'current' : 'uncertain';
  const validated = await validateClaimReview(second); assert.equal(validated.disagreementsWithAuthor.length, 1);
  const comparison = await compareClaimReviews(first, second);
  assert.equal(comparison.statesAgree, 47); assert.equal(comparison.materialsAgree, 48);
  assert.equal(comparison.disagreements.length, 1); assert.equal(comparison.adjudicated, false); assert.equal(comparison.independentReview, false);
  await assert.rejects(compareClaimReviews(first, first), /Distinct declared/);
});

test('label freeze rejects author and simulation reviews and never certifies externally declared identity', async () => {
  for (const relationship of ['author-declared', 'simulation'] as const) await assert.rejects(freezeClaimReview(await completed('fixture-a', relationship)), /external-declared/);
  const externalFixture = await completed('external-fixture', 'external-declared');
  const frozen = await freezeClaimReview(externalFixture);
  assert.equal(frozen.status, 'labels-frozen-runtime-unpinned'); assert.equal(frozen.evaluationReady, false);
  assert.equal(frozen.independentReview, false); assert.equal(frozen.blindingVerified, false); assert.equal(frozen.modelRunsPerformedByThisCommand, 0);
  const assisted = structuredClone(externalFixture); assisted.reviewer.usedModel = true;
  await assert.rejects(freezeClaimReview(assisted), /unassisted, unexposed/);
  const exposed = structuredClone(externalFixture); exposed.reviewer.sawAuthorLabelsOrModelOutputs = true;
  await assert.rejects(freezeClaimReview(exposed), /unassisted, unexposed/);
  const row = externalFixture.cases.find((c) => c.annotation.claims.length)!; row.annotation.claims[0]!.topic = 'other';
  assert.notEqual((await freezeClaimReview(externalFixture)).annotationDigest, frozen.annotationDigest);
});

test('CLI exports, validates and compares offline; invalid freezes create no artifact and outputs cannot be overwritten', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'claim-review-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../src/claim-review-cli.js', import.meta.url));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH }, maxBuffer: 1024 * 1024 });
  const blank = join(directory, 'blank.json'), first = join(directory, 'a.json'), second = join(directory, 'b.json');
  await run('--export', '--output', blank);
  await assert.rejects(run('--export', '--output', blank), /EEXIST/);
  const rejected = join(directory, 'rejected.json');
  await assert.rejects(run('--freeze', blank, '--output', rejected));
  await assert.rejects(readFile(rejected), /ENOENT/);
  await writeFile(first, JSON.stringify(await completed('fixture-a'))); await writeFile(second, JSON.stringify(await completed('fixture-b')));
  const validated = join(directory, 'validated.json'), compared = join(directory, 'compared.json');
  await run('--validate', first, '--output', validated); await run('--compare', second, '--input', first, '--output', compared);
  assert.equal(JSON.parse(await readFile(compared, 'utf8')).statesAgree, 48);
  assert.equal(JSON.parse(await readFile(validated, 'utf8')).reviewer.relationship, 'simulation');
  const externalFixture = join(directory, 'external-fixture.json'), frozen = join(directory, 'frozen-fixture.json');
  await writeFile(externalFixture, JSON.stringify(await completed('external-fixture', 'external-declared')));
  await run('--freeze', externalFixture, '--output', frozen);
  const artifact = JSON.parse(await readFile(frozen, 'utf8'));
  assert.equal(artifact.status, 'labels-frozen-runtime-unpinned'); assert.equal(artifact.independentReview, false);
  assert.match(artifact.sourceFileDigest, /^[0-9a-f]{64}$/);
  await assert.rejects(run('--export', '--freeze', first, '--output', rejected), /exactly one/);
  const oversized = join(directory, 'oversized.json'); await writeFile(oversized, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(readBoundedReview(oversized), /exceeds 1 MiB/);
});
