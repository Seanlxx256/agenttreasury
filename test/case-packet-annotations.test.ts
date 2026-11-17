import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportPacketAnnotationForm, packetEvaluationCases } from '../src/case-packet-evaluation-cases.js';
import { validatePacketAnnotations, comparePacketAnnotations, loadPacketAnnotations } from '../src/case-packet-annotations.js';
import { planPacketEvaluation, runPacketEvaluation } from '../src/evaluate-case-packets.js';

function simulatedForm(reviewer = 'fixture-reviewer') {
  const template = exportPacketAnnotationForm(), authored = packetEvaluationCases();
  return { ...template, cases: template.cases.map((row, i) => ({ ...row, annotation: { ...row.annotation,
    ...authored[i]!.annotation, reviewer, relationship: 'simulation', status: 'reviewed', reviewedAt: '2026-01-01T00:00:00.000Z' } })) };
}

test('complete annotation imports bind inputs, retain provenance and never certify independence', () => {
  const form = simulatedForm(), imported = validatePacketAnnotations(form);
  assert.equal(imported.cases.length, 12); assert.equal(imported.reviewer.relationship, 'simulation');
  assert.equal(imported.independentReview, false); assert.equal(imported.promotionEligible, false);
  assert.equal(imported.reviewer.identityVerified, false); assert.deepEqual(imported.disagreementsWithAuthor, []);
  const reordered = structuredClone(form); reordered.cases.reverse();
  for (const row of reordered.cases) row.annotation.issues.reverse();
  assert.equal(validatePacketAnnotations(reordered).annotationDigest, imported.annotationDigest);
  form.cases.forEach((row) => { row.annotation.relationship = 'external-declared'; });
  assert.equal(validatePacketAnnotations(form).independentReview, false);
});

test('incomplete, duplicated, altered or unversioned review inputs are rejected', () => {
  assert.throws(() => validatePacketAnnotations(exportPacketAnnotationForm()), /reviewed status/);
  for (const mutate of [
    (f: ReturnType<typeof simulatedForm>) => { f.schemaVersion = 1; },
    (f: ReturnType<typeof simulatedForm>) => { f.inputDigest = 'changed'; },
    (f: ReturnType<typeof simulatedForm>) => { f.cases.pop(); },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[1] = structuredClone(f.cases[0]!); },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.id = 'foreign-case'; },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.input.customerStatement = 'Replacement complaint'; },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.snapshot.sources[0]!.data.amountUnits = '1'; },
  ]) { const form = simulatedForm(); mutate(form); assert.throws(() => validatePacketAnnotations(form), /Invalid annotation/); }
  assert.throws(() => validatePacketAnnotations({ ...simulatedForm(), independentReview: true }), /fields/);
});

test('quotes, gaps, reviewer metadata and explicit negative labels have strict structural checks', () => {
  const edits = [
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.annotation.issues[0]!.quote += ' invented'; },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.annotation.issues[0]!.sourceId = 'journal'; },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.annotation.issues.push(f.cases[0]!.annotation.issues[0]!); },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.annotation.requiredGapIds = ['refund-linkage']; },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.annotation.requiredGapIds.push('second-charge'); },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.annotation.rationale = ' '; },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.annotation.reviewer = 'different-person'; },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.annotation.relationship = 'verified'; },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.annotation.reviewedAt = '2026-02-30T00:00:00.000Z'; },
    (f: ReturnType<typeof simulatedForm>) => { f.cases[0]!.annotation.reviewedAt = '2099-01-01T00:00:00.000Z'; },
  ];
  for (const edit of edits) { const form = simulatedForm(); edit(form); assert.throws(() => validatePacketAnnotations(form), /Invalid annotation/); }
  const accepted = validatePacketAnnotations(simulatedForm()); assert.deepEqual(accepted.cases[4]!.annotation.issues, []);
});

test('review disagreements are retained rather than forced to match author answers or automatically adjudicated', () => {
  const first = validatePacketAnnotations(simulatedForm('fixture-a')), alternative = simulatedForm('fixture-b');
  alternative.cases[0]!.annotation.issues[0]!.topic = 'other'; alternative.cases[0]!.annotation.requiredGapIds = ['clarify-claim'];
  const second = validatePacketAnnotations(alternative); assert.equal(second.disagreementsWithAuthor.length, 1);
  const comparison = comparePacketAnnotations(first, second);
  assert.equal(comparison.topicPairAgreementCases, 11); assert.equal(comparison.materialAgreementCases, 11);
  assert.equal(comparison.disagreements.length, 1); assert.equal(comparison.adjudicated, false); assert.equal(comparison.independentReview, false);
  assert.throws(() => comparePacketAnnotations(first, first), /distinct declared/);
});

test('evaluation uses the imported labels while still withholding labels from model input and pinning their digest', async () => {
  const form = simulatedForm(); form.cases[0]!.annotation.issues[0]!.topic = 'other'; form.cases[0]!.annotation.requiredGapIds = ['clarify-claim'];
  const imported = validatePacketAnnotations(form);
  const plan = await planPacketEvaluation(undefined, async () => { throw new Error('Unexpected network'); }, imported);
  const report = await runPacketEvaluation(plan, async () => { throw new Error('Unexpected network'); });
  assert.equal(report.labelSource, 'simulation'); assert.equal(report.independentReview, false);
  assert.ok(report.cases[0]!.baseline.score.missing.includes('other'));
  assert.equal(report.annotationReview!.annotationDigest, imported.annotationDigest);
  (plan.annotationReview!.form.cases as ReturnType<typeof simulatedForm>['cases'])[0]!.annotation.rationale += ' Changed after planning.';
  await assert.rejects(runPacketEvaluation(plan), /Annotations changed/);
});

test('annotation CLI validates, compares and evaluates without overwriting outputs; oversized inputs fail', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'packet-annotations-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, 'first.json'), second = join(directory, 'second.json');
  await writeFile(first, JSON.stringify(simulatedForm('fixture-a'))); await writeFile(second, JSON.stringify(simulatedForm('fixture-b')));
  const cli = fileURLToPath(new URL('../src/evaluate-case-packets.js', import.meta.url));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH }, maxBuffer: 1024 * 1024 });
  const validated = join(directory, 'validated.json'), compared = join(directory, 'compared.json'), evaluated = join(directory, 'evaluated.json');
  await run('--validate-review', '--annotations', first, '--output', validated);
  assert.equal(JSON.parse(await readFile(validated, 'utf8')).reviewer.relationship, 'simulation');
  await run('--compare-review', second, '--annotations', first, '--output', compared);
  assert.equal(JSON.parse(await readFile(compared, 'utf8')).topicPairAgreementCases, 12);
  await run('--rules-only', '--annotations', first, '--output', evaluated);
  assert.equal(JSON.parse(await readFile(evaluated, 'utf8')).summary.baseline.cases, 12);
  await assert.rejects(run('--validate-review', '--annotations', first, '--output', validated), /EEXIST/);
  const oversized = join(directory, 'oversized.json'); await writeFile(oversized, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(loadPacketAnnotations(oversized), /exceeds 1 MiB/);
  assert.match((await loadPacketAnnotations(first)).sourceFileDigest, /^[0-9a-f]{64}$/);
});
