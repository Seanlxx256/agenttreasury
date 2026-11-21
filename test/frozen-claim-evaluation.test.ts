import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exportClaimReview, loadClaimReviewDataset, freezeClaimReview, digest } from '../src/claim-review.js';
import { claimRuntimeIdentity, planFrozenClaimEvaluation, verifyFrozenClaimLabels, verifyFrozenClaimPlan, writeClaimPlan } from '../src/frozen-claim-evaluation.js';
import { compareClaimCases, captureClaimComparison, summarizeClaimComparison, type ArmResult } from '../src/claim-comparison.js';
import { scoreReviewedClaims, scoreReviewedMaterials, scoreAssertionStates, wilson95, type ReviewedClaimCase } from '../src/claim-comparison-scoring.js';
import { packetInterpretationOptions, packetInterpretationPrompt } from '../src/gateway-case-packet.js';
import { structuredClaimOptions, claimAssessmentPrompt } from '../src/gateway-claim-assessment.js';

// Only these two synthetic fixtures enter the comparison engine. None of the
// 48 review inputs is classified, parsed for materials or sent to a model here.
const fixtures: ReviewedClaimCase[] = [
  { id: 'engine-fixture-positive', input: { customerStatement: 'Fixture archive is unusable. Order FX_800 has error BAD_800.', merchantStatement: '' },
    annotation: { claims: [{ topic: 'delivery-unusable', state: 'current', sourceId: 'statement-customer', quote: 'archive is unusable' }],
      materials: [{ field: 'order-reference', sourceId: 'statement-customer', quote: 'FX_800' }, { field: 'error', sourceId: 'statement-customer', quote: 'BAD_800' }], rationale: 'GOLD_ONLY_RATIONALE' } },
  { id: 'engine-fixture-negative', input: { customerStatement: 'There is no duplicate charge in this fixture.', merchantStatement: '' },
    annotation: { claims: [{ topic: 'duplicate-charge', state: 'denied', sourceId: 'statement-customer', quote: 'no duplicate charge' }], materials: [], rationale: 'GOLD_ONLY_RATIONALE' } },
];
const reply = (data: unknown) => Response.json({ message: { content: JSON.stringify(data) }, prompt_eval_count: 30, eval_count: 12, done_reason: 'stop' });

function fixtureRequest(log: string[], failLegacy = false): typeof fetch {
  return async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(init?.body));
    assert.ok(!String(init?.body).includes('GOLD_ONLY_RATIONALE')); assert.ok(!String(init?.body).includes('engine-fixture-'));
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual(Object.keys(input), ['claims']);
    const sample = fixtures.find((f) => f.input.customerStatement === input.claims[0].text)!; assert.ok(sample);
    const legacy = body.format.required.includes('issues'); log.push(legacy ? 'legacy' : 'structured');
    assert.equal(body.messages[0].content, legacy ? packetInterpretationPrompt : claimAssessmentPrompt);
    assert.deepEqual(body.options, legacy ? packetInterpretationOptions : structuredClaimOptions);
    if (legacy && failLegacy) return new Response('fixture unavailable', { status: 503 });
    return legacy ? reply({ issues: sample.annotation.claims.filter((c) => c.state === 'current').map(({ state: _state, ...issue }) => issue) })
      : reply({ claims: sample.annotation.claims, materials: [] });
  };
}
const metadataRequest = (modelDigest = 'a'.repeat(64)): typeof fetch => async (url) => {
  if (url === 'http://127.0.0.1:11434/api/tags') return Response.json({ models: [{ name: 'fixture:tiny', digest: modelDigest }] });
  assert.equal(url, 'http://127.0.0.1:11434/api/version', 'planning must never perform inference');
  return Response.json({ version: 'fixture-ollama-version' });
};
async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ag-claim-engine-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function labelFixture(t: TestContext) {
  const dir = await directory(t), form = await exportClaimReview(), dataset = await loadClaimReviewDataset();
  // A fabricated declaration used only to exercise gates, never published as a review.
  form.reviewer = { id: 'synthetic-external-fixture', relationship: 'external-declared', reviewedAt: new Date().toISOString(), usedModel: false, sawAuthorLabelsOrModelOutputs: false };
  for (const row of form.cases) row.annotation = { ...structuredClone(dataset.authors.find((a) => a.id === row.id)!.annotation), status: 'reviewed' };
  const review = join(dir, 'review-fixture.json'), labels = join(dir, 'labels-fixture.json');
  const text = JSON.stringify(form, null, 2) + '\n'; await writeFile(review, text);
  const frozen = { ...await freezeClaimReview(form), sourceFileDigest: digest(text) };
  await writeFile(labels, JSON.stringify(frozen, null, 2) + '\n'); return { dir, review, labels, frozen, form };
}

test('scoring counts failed negatives, missing positive pairs and unsupported citations without duplicate rewards', () => {
  const positive = fixtures[0]!, negative = fixtures[1]!, issue = positive.annotation.claims[0]!;
  const good = scoreReviewedClaims(positive, [issue, issue], true);
  assert.equal(good.truePositives, 1); assert.equal(good.candidateQuotes, 1); assert.equal(good.supportedExact, true);
  assert.equal(scoreReviewedClaims(negative, [], false).exact, false);
  assert.equal(scoreReviewedClaims(positive, [], false).falseNegatives, 1);
  const badQuote = scoreReviewedClaims(positive, [{ ...issue, quote: 'invented' }], true);
  assert.equal(badQuote.exact, true); assert.equal(badQuote.supportedExact, false); assert.equal(badQuote.unsupported, 1);
  const foreign = scoreReviewedClaims(positive, [{ ...issue, sourceId: 'statement-merchant' }], true);
  assert.equal(foreign.falsePositives, 1); assert.equal(foreign.falseNegatives, 1);
});

test('assertion support, material coverage and uncertainty are distinct metrics', () => {
  const sample = fixtures[0]!;
  assert.equal(scoreAssertionStates(sample, sample.annotation.claims, true).supportedExact, true);
  assert.equal(scoreAssertionStates(sample, [{ ...sample.annotation.claims[0]!, state: 'denied' }], true).exact, false);
  assert.equal(scoreAssertionStates(fixtures[1]!, [], false).exact, false);
  const material = sample.annotation.materials[0]!;
  const score = scoreReviewedMaterials(sample, [material, material, { ...material, sourceId: 'statement-merchant' }]);
  assert.equal(score.found, 1); assert.equal(score.missed, 1); assert.equal(score.unsupported, 1); assert.equal(score.candidates, 2);
  assert.equal(scoreReviewedMaterials(fixtures[1]!, [], false).exact, false);
  assert.equal(wilson95(0, 0), null); assert.ok(wilson95(0, 10)!.high > 0); assert.ok(wilson95(10, 10)!.low < 1);
});

test('three arms share isolated inputs, alternate order and keep failed model attempts separate from fallback', async () => {
  const calls: string[] = [], captured: ArmResult[] = []; let checks = 0;
  const rows = await compareClaimCases(fixtures, 'fixture:tiny', fixtureRequest(calls, true), { verify: async () => { checks++; }, capture: async (r) => { captured.push(r); } });
  assert.deepEqual(calls, ['legacy', 'structured', 'structured', 'legacy']); assert.equal(checks, 12); assert.equal(captured.length, 6);
  const summary = summarizeClaimComparison(rows, fixtures.map((c) => c.id));
  const legacy = summary.groups.find((g) => g.method === 'legacy-model')!;
  assert.equal(legacy.attempted, 2); assert.equal(legacy.statuses.unavailable, 2); assert.equal(legacy.exact, 0); assert.equal(legacy.fallbackCases, 2);
  const structured = summary.groups.find((g) => g.method === 'structured-model')!;
  assert.equal(structured.supportedExact, 2); assert.equal(structured.rawModelMaterials!.found, 0); assert.equal(structured.rawModelMaterials!.missed, 2);
  assert.equal(summary.deterministicMaterials.found, 2); assert.equal(summary.promotionEligible, false);
  const heldNegative = rows.find((r) => r.caseId === fixtures[1]!.id && r.method === 'context-rules')!;
  assert.equal(heldNegative.score.exact, true); assert.equal(heldNegative.workflow.supportedWithoutReview, false);
  assert.throws(() => summarizeClaimComparison(rows.slice(1), fixtures.map((c) => c.id)), /partial/);
  assert.throws(() => summarizeClaimComparison([rows[0]!, ...rows.slice(1, -1), rows[0]!], fixtures.map((c) => c.id)), /partial/);
});

test('captured report matches its complete journal and refuses overwrites before inference', async (t) => {
  const dir = await directory(t), output = join(dir, 'fixture-report.json');
  const calls: string[] = []; const plan = { fixtureOnly: true, independentReview: false };
  const report = await captureClaimComparison(output, plan, (capture) => compareClaimCases(fixtures, 'fixture:tiny', fixtureRequest(calls), { verify: async () => {}, capture }), fixtures.map((c) => c.id));
  assert.equal(report.status, 'complete'); assert.equal(report.summary.cases, 2); assert.equal(report.independentReview, false);
  const events = (await readFile(output + '.cases.jsonl', 'utf8')).trim().split('\n').map((s) => JSON.parse(s));
  assert.equal(events.filter((e) => e.event === 'arm-completed').length, 6);
  assert.equal(report.planDigest, digest(await readFile(output + '.plan.json')));
  await assert.rejects(captureClaimComparison(output, plan, async () => { assert.fail('Must not invoke job'); }, []), /EEXIST/);
  const collision = join(dir, 'collision.json'); await writeFile(collision + '.plan.json', 'existing');
  await assert.rejects(captureClaimComparison(collision, plan, async () => { assert.fail('Must not invoke job'); }, []), /EEXIST/);
  assert.equal(await readFile(collision + '.plan.json', 'utf8'), 'existing');
});

test('identity drift after a completed arm preserves its evidence but produces no complete report', async (t) => {
  const dir = await directory(t), output = join(dir, 'interrupted.json'); let verifications = 0; const calls: string[] = [];
  await assert.rejects(captureClaimComparison(output, { fixtureOnly: true }, (capture) => compareClaimCases(fixtures, 'fixture:tiny', fixtureRequest(calls), {
    capture, verify: async () => { if (++verifications === 4) throw new Error('Fixture model changed'); },
  }), fixtures.map((c) => c.id)), /model changed/);
  assert.equal(await readFile(output, 'utf8'), ''); assert.deepEqual(calls, ['legacy']);
  const events = (await readFile(output + '.cases.jsonl', 'utf8')).trim().split('\n').map((s) => JSON.parse(s));
  assert.equal(events.filter((e) => e.event === 'arm-completed').length, 2); assert.equal(events.at(-1).event, 'aborted');
});

test('metadata is bounded and planning never invokes inference', async () => {
  const identity = await claimRuntimeIdentity('fixture:tiny', metadataRequest());
  assert.equal(identity.model.digest, 'a'.repeat(64)); assert.equal(identity.node, process.version);
  await assert.rejects(claimRuntimeIdentity('fixture:tiny', async () => new Response('x'.repeat(65537))), /too large/);
  await assert.rejects(claimRuntimeIdentity('fixture:tiny', metadataRequest('bad-digest')), /SHA-256/);
});

test('final results cannot differ from the durable per-arm journal', async (t) => {
  const dir = await directory(t), output = join(dir, 'mismatched.json');
  await assert.rejects(captureClaimComparison(output, { fixtureOnly: true }, async (capture) => {
    const rows = await compareClaimCases(fixtures, 'fixture:tiny', fixtureRequest([]), { verify: async () => {}, capture });
    rows[0]!.score.exact = !rows[0]!.score.exact;
    return rows;
  }, fixtures.map((c) => c.id)), /differ from captured journal/);
  assert.equal(await readFile(output, 'utf8'), '');
  const events = (await readFile(output + '.cases.jsonl', 'utf8')).trim().split('\n').map((s) => JSON.parse(s));
  assert.equal(events.at(-1).event, 'aborted');
});

test('frozen labels must exactly match the original review bytes, corpus and provenance', async (t) => {
  const f = await labelFixture(t);
  const verified = await verifyFrozenClaimLabels(f.labels, f.review); assert.equal(verified.freeze.independentReview, false);
  const tampered = structuredClone(f.frozen); tampered.cases[0]!.annotation.rationale += ' tampered';
  await writeFile(f.labels, JSON.stringify(tampered)); await assert.rejects(verifyFrozenClaimLabels(f.labels, f.review), /differ/);
  await writeFile(f.labels, JSON.stringify(f.frozen)); await writeFile(f.review, JSON.stringify(f.form));
  await assert.rejects(verifyFrozenClaimLabels(f.labels, f.review), /differ/); // Even harmless byte changes need a new freeze.
});

test('plan locks code, prompts, scoring, cases and runtime while retaining unverified reviewer declarations', async (t) => {
  const f = await labelFixture(t);
  const plan = await planFrozenClaimEvaluation(f.labels, f.review, 'fixture:tiny', metadataRequest());
  assert.equal(plan.cases.length, 48); assert.equal(plan.independentReview, false); assert.equal(plan.promotionEligible, false);
  assert.equal(plan.contract.prompts.legacy, packetInterpretationPrompt);
  assert.equal(plan.contract.prompts.structured, claimAssessmentPrompt);
  for (const path of ['src/claim-comparison-scoring.ts', 'dist/src/claim-comparison.js', 'src/claim-review.ts', 'src/gateway-case-packet.ts', 'package-lock.json']) assert.ok(plan.files[path]);
  const planFile = join(f.dir, 'plan-fixture.json'); await writeClaimPlan(planFile, plan);
  await assert.rejects(writeClaimPlan(planFile, plan), /EEXIST/);
  for (const mutate of [
    (p: typeof plan) => { p.cases.pop(); }, (p: typeof plan) => { p.annotationDigest = 'tampered'; },
    (p: typeof plan) => { p.contract.prompts.legacy += ' changed'; }, (p: typeof plan) => { p.files['src/claim-comparison-scoring.ts'] = 'changed'; },
  ]) {
    const bad = structuredClone(plan); mutate(bad);
    await assert.rejects(verifyFrozenClaimPlan(bad, f.labels, f.review, async () => { assert.fail('No metadata on local plan drift'); }), /changed/);
  }
  await assert.rejects(verifyFrozenClaimPlan(plan, f.labels, f.review, metadataRequest('b'.repeat(64))), /runtime changed/);
});

test('blank and simulation reviews fail before any model contact; CLI has no fixture bypass', async (t) => {
  const dir = await directory(t), blankPath = join(dir, 'blank.json'), planPath = join(dir, 'plan.json');
  await writeFile(blankPath, JSON.stringify(await exportClaimReview()));
  await assert.rejects(planFrozenClaimEvaluation(blankPath, blankPath, 'fixture:tiny', async () => { assert.fail('No network before review'); }), /pseudonym/);
  const f = await labelFixture(t); f.form.reviewer.relationship = 'simulation';
  await writeFile(f.review, JSON.stringify(f.form));
  await assert.rejects(planFrozenClaimEvaluation(f.labels, f.review, 'fixture:tiny', async () => { assert.fail('No network for simulation'); }), /external-declared/);
  const cli = fileURLToPath(new URL('../src/frozen-claim-evaluation-cli.js', import.meta.url));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH } });
  await assert.rejects(run('--plan', '--labels', blankPath, '--review', blankPath, '--model', 'fixture:tiny', '--output', planPath), /pseudonym/);
  await assert.rejects(readFile(planPath), /ENOENT/);
  await assert.rejects(run('--fixture'), /Unknown option/);
});
