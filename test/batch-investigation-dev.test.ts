import assert from 'node:assert/strict';
import { test } from 'node:test';
import { developmentCases } from '../src/batch-investigation-dev-cases.js';
import { decideDevRules, devDecisionErrors, devPayload, devPrompt, prepareDevEvidence, runDevModel } from '../src/batch-investigation-dev.js';
import { evaluateDevPlan, planDevEvaluation, scoreDevDecision, summarizeDevScores } from '../src/evaluate-batch-investigation-dev.js';
import { pointerValue } from '../src/batch-investigation-eval.js';

const cases = developmentCases(), sample = cases[0]!.evidence;
const good = { status: 'corroborated', checks: ['read-balance-evidence'], citations: ['/input/snapshot'] };
const reply = (content: string) => Response.json({ message: { content }, prompt_eval_count: 100, eval_count: 20, done_reason: 'stop' });

test('new development labels have valid citations, independent identities and a reproducible rule baseline', async () => {
  const plan = await planDevEvaluation([]);
  assert.equal(plan.cases.length, 8); assert.equal(plan.holdout, false); assert.equal(plan.promotionEligible, false);
  assert.deepEqual(cases, developmentCases());
  assert.equal(new Set(cases.map((row) => row.evidence.input.purchase.nonce)).size, 8);
  for (const row of cases) {
    const prepared = prepareDevEvidence(row.evidence), decision = decideDevRules(row.evidence);
    assert.deepEqual(devDecisionErrors(decision, prepared.permittedCitations), []);
    for (const path of row.label.requiredPaths) assert.notEqual(pointerValue(row.evidence, path), undefined);
    assert.equal(scoreDevDecision(decision, row.label).strictSuccess, true, row.id);
  }
  const report = await evaluateDevPlan(plan);
  assert.equal(report.rules.summary.strictSuccesses, 8); assert.equal(report.calls.length, 0);
  plan.cases[0]!.label.status = 'conflict';
  await assert.rejects(evaluateDevPlan(plan), /plan changed/);
});

test('compact and full share deterministic facts and citation identity, never labels or financial authority', async () => {
  for (const row of cases) {
    const full = devPayload(row.evidence, 'full'), compact = devPayload(row.evidence, 'compact');
    assert.deepEqual(full.facts, compact.facts); assert.equal(full.evidenceDigest, compact.evidenceDigest);
    assert.deepEqual(full.permittedCitations, compact.permittedCitations);
    assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(full)));
    assert.ok(!JSON.stringify(compact).includes('transactionInput'));
    for (const fact of compact.facts) for (const path of fact.sources) assert.notEqual(pointerValue(row.evidence, path), undefined);
    assert.equal(compact.financialAuthority, false); assert.equal(compact.cryptographicAuthorizationInclusion, false);
  }
  const run = await runDevModel(sample, 'compact', 'fixture', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat'); assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)); assert.equal(body.messages[0].content, devPrompt);
    const payload = JSON.parse(body.messages[1].content);
    assert.deepEqual(payload, devPayload(sample, 'compact'));
    for (const key of ['label', 'requiredChecks', 'requiredPaths', 'allowedPaths', 'rationale', 'dev-01-consistent']) {
      assert.ok(!String(init?.body).includes(key));
    }
    return reply(JSON.stringify(good));
  });
  assert.equal(run.status, 'ready'); assert.equal(run.rawOutput, JSON.stringify(good));
  assert.equal(run.promptTokens, 100); assert.equal(run.outputTokens, 20); assert.equal(run.doneReason, 'stop');
});

test('stale and failed refresh evidence cannot become corroborated; wallet balance discrepancy is retained', () => {
  for (const index of [2, 3]) assert.equal(decideDevRules(cases[index]!.evidence).status, 'incomplete');
  const conflict = prepareDevEvidence(cases[6]!.evidence);
  assert.equal(conflict.facts.find((fact) => fact.id === 'wallet-accounting')?.state, 'conflict');
  const invalid = prepareDevEvidence(cases[7]!.evidence);
  assert.equal(invalid.facts.find((fact) => fact.id === 'raw-batch')?.state, 'conflict');
  assert.equal(decideDevRules(cases[5]!.evidence).status, 'conflict');
  const empty = structuredClone(sample); empty.input.snapshot.ledgerScope = 'none';
  assert.equal(decideDevRules(empty).status, 'incomplete');
});

test('precise schema rejection records preserve raw claims without fallback credit', async () => {
  const invalid = { ...good, status: ['corroborated'], checks: ['refund-now', 'refund-now'], citations: ['/invented'], execute: true };
  const run = await runDevModel(sample, 'compact', 'fixture', async () => reply(JSON.stringify(invalid)));
  assert.equal(run.status, 'rejected'); assert.equal(run.decision, null); assert.equal(run.rawOutput, JSON.stringify(invalid));
  assert.deepEqual(run.reasons, [
    { code: 'unexpected-field', path: '/execute' }, { code: 'invalid-status', path: '/status' },
    { code: 'not-permitted', path: '/checks/0' }, { code: 'not-permitted', path: '/checks/1' },
    { code: 'duplicate', path: '/checks/1' }, { code: 'not-permitted', path: '/citations/0' },
  ]);
  const falseClaim = await runDevModel(sample, 'compact', 'fixture', async () => reply(JSON.stringify({ ...good, checks: [] })));
  assert.equal(falseClaim.candidateStatus, 'corroborated');
  assert.equal(scoreDevDecision(falseClaim.decision, cases[2]!.label, falseClaim.candidateStatus).falseCorroboration, true);
  assert.deepEqual(devDecisionErrors(null, []), [{ code: 'object-required', path: '/' }]);
  assert.ok(devDecisionErrors({}, []).some((error) => error.code === 'required-field'));
});

test('format, transport, timeout, HTTP and oversized responses are distinguished and bounded', async () => {
  const run = (request: typeof fetch) => runDevModel(sample, 'compact', 'fixture', request);
  const broken = await run(async () => reply('{not JSON'));
  assert.equal(broken.reasons[0]!.code, 'invalid-output-json'); assert.equal(broken.rawOutput, '{not JSON');
  const large = await run(async () => reply('x'.repeat(8001)));
  assert.equal(large.reasons[0]!.code, 'content-too-large'); assert.equal(large.rawOutput?.length, 8000); assert.equal(large.rawOutputTruncated, true);
  const envelope = await run(async () => new Response('x'.repeat(65537)));
  assert.equal(envelope.reasons[0]!.code, 'response-too-large'); assert.equal(envelope.rawOutput, null);
  const missing = await run(async () => Response.json({ message: {} }));
  assert.equal(missing.reasons[0]!.code, 'content-required');
  const badEnvelope = await run(async () => new Response('invalid'));
  assert.equal(badEnvelope.reasons[0]!.code, 'invalid-envelope-json');
  const http = await run(async () => new Response('not copied', { status: 503 }));
  assert.equal(http.reasons[0]!.code, 'http-error'); assert.equal(http.httpStatus, 503);
  const timeout = await run(async () => { throw new DOMException('expired', 'TimeoutError'); });
  assert.equal(timeout.reasons[0]!.code, 'timeout');
  const transport = await run(async () => { throw new TypeError('offline'); });
  assert.equal(transport.reasons[0]!.code, 'transport-error'); assert.equal(transport.status, 'unavailable');
  const oversized = structuredClone(sample); oversized.context.providerRead.code = 'x'.repeat(48000);
  let called = false;
  const inputLimit = await runDevModel(oversized, 'full', 'fixture', async () => { called = true; return reply('{}'); });
  assert.equal(called, false); assert.equal(inputLimit.reasons[0]!.code, 'input-too-large');
});

test('annotation scoring distinguishes existence, support and mandatory reads without duplicate inflation', () => {
  const row = cases[2]!;
  const correct = decideDevRules(row.evidence);
  const extra = scoreDevDecision({ ...correct, citations: [...correct.citations, '/input/journal'] }, row.label);
  assert.equal(extra.correct, true); assert.equal(extra.unsupportedByAnnotation, 1); assert.equal(extra.strictSuccess, false);
  const duplicated = scoreDevDecision({ ...correct, checks: [...correct.checks, ...correct.checks], citations: [...correct.citations, ...correct.citations] }, row.label);
  assert.equal(duplicated.requiredChecksFound, 1); assert.equal(duplicated.requiredPathsFound, 2);
  assert.equal(summarizeDevScores([extra, scoreDevDecision(null, row.label)]).correct, 1);
});

test('preflight records model digests and alternates paired view order before inference', async () => {
  const urls: string[] = [];
  const plan = await planDevEvaluation(['qwen2.5:1.5b'], async (url) => {
    urls.push(String(url));
    return String(url).endsWith('/api/tags') ? Response.json({ models: [{ name: 'qwen2.5:1.5b', digest: 'a'.repeat(64), details: {} }] })
      : Response.json({ version: 'fixture' });
  });
  assert.equal(urls.length, 2); assert.equal(plan.models[0]!.digest, 'a'.repeat(64));
  assert.deepEqual(plan.order.slice(0, 4).map((row) => row.view), ['full', 'compact', 'compact', 'full']);
  assert.ok(plan.files['src/batch-investigation-dev.ts']); assert.ok(plan.files['dist/src/batch-investigation-dev.js']);
  await assert.rejects(planDevEvaluation(['qwen2.5:7b']), /development models/);
  await assert.rejects(planDevEvaluation(['qwen2.5:1.5b'], async () => Response.json({ models: [] })), /Missing model identity/);
});
