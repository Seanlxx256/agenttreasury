import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpretStructuredClaims, prepareClaimAssistance, validateClaimAssessment } from '../src/gateway-claim-assessment.js';
import { assembleCasePacket, statementSources } from '../src/gateway-case-packet.js';
import { packetEvaluationSnapshot } from '../src/case-packet-evaluation-cases.js';
import { packetEvaluationCases } from '../src/case-packet-evaluation-cases.js';
import { claimAssessmentCases } from '../src/claim-assessment-cases.js';
import { scoreCurrentClaims } from '../src/evaluate-claim-assessment.js';

const input = { customerStatement: 'I was not charged twice. My download fails with error E-91 for order Q-19.', merchantStatement: 'The refund is only hypothetical.' };
const sources = statementSources(input);
const output = { claims: [
  { topic: 'duplicate-charge', state: 'denied', sourceId: 'statement-customer', quote: 'I was not charged twice.' },
  { topic: 'delivery-unusable', state: 'current', sourceId: 'statement-customer', quote: 'My download fails with error E-91 for order Q-19.' },
  { topic: 'refund-claimed', state: 'hypothetical', sourceId: 'statement-merchant', quote: 'The refund is only hypothetical.' },
], materials: [{ field: 'error', sourceId: 'statement-customer', quote: 'error E-91' }, { field: 'order-reference', sourceId: 'statement-customer', quote: 'order Q-19' }] };
const respond = (value: unknown) => Response.json({ message: { content: JSON.stringify(value) }, prompt_eval_count: 30, eval_count: 40 });

test('structured claims isolate statements, retain denial and material evidence, and do not change financial facts', async () => {
  const result = await interpretStructuredClaims([...sources, { id: 'secret', kind: 'local-record', locator: 'db', data: { secret: 'DO_NOT_SEND' } }], 'fixture', async (_, init) => {
    const body = JSON.parse(String(init?.body)); assert.ok(!JSON.stringify(body).includes('DO_NOT_SEND'));
    assert.deepEqual(JSON.parse(body.messages[1].content).claims.map((s: { id: string }) => s.id), ['statement-customer', 'statement-merchant']);
    return respond(output);
  });
  assert.equal(result.status, 'ready'); assert.deepEqual(result.issues.map((i) => i.topic), ['delivery-unusable']);
  assert.equal(result.assessment!.claims.length, 3); assert.equal(result.assessment!.verification, 'unverified');
  const packet = assembleCasePacket(packetEvaluationSnapshot(false), input, result);
  assert.equal(packet.financialAuthority, false); assert.equal(packet.claimAssistance!.reviewRequired, true);
  const fields = packet.claimAssistance!.followups[0]!.fields;
  assert.equal(fields.find((f) => f.field === 'error')!.status, 'provided-unverified');
  assert.equal(fields.find((f) => f.field === 'time')!.status, 'not-extracted');
  const disabled = assembleCasePacket(packetEvaluationSnapshot(false), input, await interpretStructuredClaims(sources));
  assert.deepEqual(packet.recordedFacts, disabled.recordedFacts);
});

test('assessment gate rejects invented sources, quotes, financial fields and duplicate contradictory states', () => {
  assert.equal(validateClaimAssessment(output, sources), true);
  for (const value of [{ ...output, execute: 'refund' }, { ...output, materials: [{ field: 'private-key', sourceId: 'statement-customer', quote: 'order Q-19' }] },
    { ...output, claims: [{ ...output.claims[0], sourceId: 'purchase' }] },
    { ...output, claims: [{ ...output.claims[0], quote: 'invented debit' }] },
    { ...output, claims: [...output.claims, { ...output.claims[0], state: 'current' }] }]) assert.equal(validateClaimAssessment(value, sources), false);
});

test('stale statements and cross-party references cannot silently fill material requirements', async () => {
  const result = await interpretStructuredClaims(sources, 'fixture', async () => respond(output));
  const changed = statementSources({ ...input, customerStatement: input.customerStatement + ' I retract that report.' });
  const report = prepareClaimAssistance(result.assessment, changed)!;
  assert.equal(report.followups.length, 0); assert.ok(report.claims.some((c) => c.stale));
  const mixed = structuredClone(result.assessment!);
  mixed.materials.push({ field: 'time', sourceId: 'statement-merchant', quote: 'hypothetical' });
  assert.equal(prepareClaimAssistance(mixed, sources)!.followups[0]!.fields.find((f) => f.field === 'time')!.status, 'not-extracted');
});

test('disabled, malformed, oversized and unavailable model attempts are explicit', async () => {
  assert.equal((await interpretStructuredClaims(sources)).status, 'disabled');
  assert.equal((await interpretStructuredClaims(sources, 'fixture', async () => respond({ claims: [], materials: [], execute: true }))).status, 'rejected');
  assert.equal((await interpretStructuredClaims(sources, 'fixture', async () => new Response('x'.repeat(65537)))).reason, 'response-too-large');
  assert.equal((await interpretStructuredClaims(sources, 'fixture', async () => { throw new Error('secret'); })).reason, 'model-read-failed');
});

test('new development annotations bind exact source quotes and do not reuse previous case text', () => {
  const old = new Set(packetEvaluationCases().flatMap((c) => Object.values(c.input)).filter(Boolean));
  const cases = claimAssessmentCases(); assert.equal(cases.length, 12);
  for (const sample of cases) {
    assert.ok(Object.values(sample.input).filter(Boolean).every((text) => !old.has(text)));
    assert.equal(validateClaimAssessment(sample.expected, statementSources(sample.input)), true);
    const current = sample.expected.claims.filter((c) => c.state === 'current' || c.state === 'uncertain');
    assert.equal(scoreCurrentClaims(current, current).supportedExact, true);
    if (current.length) {
      assert.equal(scoreCurrentClaims([{ ...current[0]!, sourceId: 'invented' }], current).supportedExact, false);
      assert.equal(scoreCurrentClaims([{ ...current[0]!, quote: 'invented' }], current).supportedExact, false);
    }
  }
});
