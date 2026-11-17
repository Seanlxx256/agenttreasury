import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { packetEvaluationCases, exportPacketAnnotationForm } from '../src/case-packet-evaluation-cases.js';
import { statementSources } from '../src/gateway-case-packet.js';
import { evaluatePacketCase, scorePacketTopics, summarizePacketEvaluation, planPacketEvaluation, runPacketEvaluation } from '../src/evaluate-case-packets.js';

const cases = packetEvaluationCases();
const respond = (issues: unknown[]) => Response.json({ message: { content: JSON.stringify({ issues }) } });

test('new packet development cases bind annotations to sources and do not reuse the old smoke inputs', async () => {
  assert.equal(cases.length, 12); assert.equal(new Set(cases.map((c) => c.id)).size, 12);
  const old = JSON.parse(await readFile(new URL('../../docs/evidence/stage-10-case-packet-smoke.json', import.meta.url), 'utf8'));
  for (const sample of cases) {
    for (const label of sample.annotation.issues) assert.ok(statementSources(sample.input).some((s) => s.id === label.sourceId && String(s.data.text).includes(label.quote)));
    assert.ok(!old.results.some((r: { customerStatement: string; merchantStatement: string }) =>
      r.customerStatement === sample.input.customerStatement && r.merchantStatement === sample.input.merchantStatement));
    assert.equal(new Set(sample.annotation.requiredGapIds).size, sample.annotation.requiredGapIds.length);
  }
  const exported = exportPacketAnnotationForm();
  for (const row of exported.cases) {
    assert.deepEqual(row.annotation.issues, []); assert.deepEqual(row.annotation.requiredGapIds, []);
    assert.equal(row.annotation.rationale, ''); assert.equal(row.annotation.reviewer, '');
    assert.ok(!('stratum' in row)); assert.ok(!('model' in row));
  }
});

test('only untrusted statements reach the production model adapter, never expected answers or payment facts', async () => {
  const sample = cases[3]!;
  const run = await evaluatePacketCase(sample, 'fixture', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(JSON.parse(payload.messages[1].content), { claims: statementSources(sample.input).map((s) => ({ id: s.id, text: s.data.text })) });
    return respond(sample.annotation.issues);
  });
  assert.equal(run.model!.status, 'ready'); assert.equal(run.model!.score!.exact, true);
  assert.equal(run.model!.score!.unsupportedCandidates, 0); assert.equal(run.assisted!.score.exactMaterialSet, true);
  assert.equal(run.assisted!.deterministicFactsUnchanged, true);
});

test('topic scores reject fabricated provenance and unsupported interpretations without duplicate inflation', () => {
  const sample = cases[0]!, label = sample.annotation.issues[0]!;
  const reordered = { quote: label.quote, topic: label.topic, sourceId: label.sourceId };
  const dedup = scorePacketTopics([label, reordered], sample.annotation, sample.input);
  assert.equal(dedup.candidateCount, 1); assert.equal(dedup.unsupportedCandidates, 0);
  for (const candidate of [{ ...label, sourceId: 'statement-merchant' }, { ...label, quote: label.quote + ' INVENTED' },
    { ...label, topic: 'refund-claimed' as const }]) {
    assert.equal(scorePacketTopics([candidate], sample.annotation, sample.input).unsupportedCandidates, 1);
  }
});

test('production union cannot remove rule false positives even when a model correctly returns no current topics', async () => {
  const run = await evaluatePacketCase(cases[4]!, 'fixture', async () => respond([]));
  assert.equal(run.model!.score!.exact, true); assert.equal(run.assisted!.score.exact, false);
  assert.deepEqual(run.assisted!.score, run.baseline.score);
  assert.ok(run.assisted!.score.unnecessaryQuestions.length > 0);
});

test('model failures remain attempts and cannot receive correct-negative or rule-fallback credit', async () => {
  const rows = await Promise.all([evaluatePacketCase(cases[4]!, 'fixture', async () => { throw new Error('offline'); }),
    evaluatePacketCase(cases[0]!, 'fixture', async () => respond([{ topic: 'duplicate-charge', sourceId: 'journal', quote: 'invented' }]))]);
  const summary = summarizePacketEvaluation(rows);
  assert.deepEqual(summary.model!.statuses, { ready: 0, rejected: 1, unavailable: 1 });
  assert.equal(summary.model!.attempted, 2); assert.equal(summary.model!.exactTopicSetsPerAttempt, 0);
  assert.equal(summary.model!.supportedExactTopicSetsPerAttempt, 0);
  assert.ok(rows.every((row) => row.model!.score === null));
  assert.equal(summary.assisted!.exactTopicSets, summary.baseline.exactTopicSets);
});

test('planned evaluation pins source hashes and model identity before any inference and journals each completed case', async () => {
  const rules = await planPacketEvaluation(undefined, async () => { throw new Error('Rules must not use network'); });
  assert.equal(rules.independentReview, false); assert.equal(rules.promotionEligible, false);
  let captured = 0;
  const result = await runPacketEvaluation(rules, async () => { throw new Error('No network'); }, async () => { captured++; });
  assert.equal(captured, 12); assert.equal(result.summary.baseline.cases, 12); assert.equal(result.summary.model, null);
  await assert.rejects(runPacketEvaluation({ ...rules, datasetDigest: 'edited' }), /sources changed/);
  const planned = await planPacketEvaluation('fixture', async () => Response.json({ models: [{ name: 'fixture', digest: 'first' }] }));
  await assert.rejects(runPacketEvaluation(planned, async (url) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/tags');
    return Response.json({ models: [{ name: 'fixture', digest: 'changed' }] });
  }), /identity changed/);
});
