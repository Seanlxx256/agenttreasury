import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareGatewayTriage, reviewGatewayTriage } from '../src/gateway-triage.js';

const ended = {
  budgetStatus: 'released', reviewRequired: false, buyerHasDelivery: false,
  sellerHasDelivery: false, journal: null,
};

test('the keyword rules reduce a direct free-text reason to a citable fact', () => {
  const input = prepareGatewayTriage(ended, [
    { id: '9', evidence: { status: 'failed', reason: 'nonce already used for this wallet' } },
  ]);
  assert.deepEqual(input.unstructured, ['nonce already used for this wallet']);
  assert.ok(input.facts.some((fact) => fact.id === 'evidence-nonce-reused'));
  assert.equal(input.rules.action, 'close-case');
});

test('a paraphrase the rules miss is recovered by the model as an extra fact', async () => {
  const input = prepareGatewayTriage(ended, [
    { id: '9', evidence: { status: 'failed', reason: 'the transfer was signed twice with the same identifier' } },
  ]);
  // The keyword table has no rule for this paraphrase, so no rule fact exists yet.
  assert.deepEqual(input.unstructured, ['the transfer was signed twice with the same identifier']);
  assert.ok(!input.facts.some((fact) => fact.id.startsWith('evidence-nonce-reused')));

  let calls = 0;
  const request: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    if (body.format?.properties?.signals) {
      // First call: unstructured evidence extraction with a verbatim quote.
      return Response.json({ message: { content: JSON.stringify({ signals: [
        { signal: 'nonce-reused', quote: 'signed twice with the same identifier' },
      ] }) } });
    }
    // Second call: support-rules action selection, citing the recovered fact.
    return Response.json({ message: { content: JSON.stringify({
      action: 'close-case', citations: ['observation-9', 'evidence-model-nonce-reused'],
    }) } });
  };

  const result = await reviewGatewayTriage(input, 'test-model', request, 'support-rules');
  assert.equal(calls, 2);
  assert.ok(result.facts.some((fact) => fact.id === 'evidence-model-nonce-reused'));
  assert.equal(result.agent.status, 'ready');
  assert.ok(result.agent.recommendation?.citations.includes('evidence-model-nonce-reused'));
});

test('structured conflict reasons stay out of the unstructured extraction path', () => {
  const input = prepareGatewayTriage(ended, [
    { id: '9', evidence: { status: 'conflict', reason: 'accounting-mismatch' } },
  ]);
  assert.deepEqual(input.unstructured, []);
  assert.ok(!input.facts.some((fact) => fact.id.startsWith('evidence-')));
});
