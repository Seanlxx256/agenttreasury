import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareGatewayTriage, reviewGatewayTriage } from '../src/gateway-triage.js';

const ended = {
  budgetStatus: 'released', reviewRequired: false, buyerHasDelivery: false,
  sellerHasDelivery: false, journal: null,
};

test('keyword interpretations stay separate from recorded facts', () => {
  const input = prepareGatewayTriage(ended, [
    { id: '9', evidence: { status: 'failed', reason: 'nonce already used for this wallet' } },
  ]);
  assert.deepEqual(input.unstructured, ['nonce already used for this wallet']);
  assert.ok(!input.facts.some((fact) => fact.id === 'evidence-nonce-reused'));
  assert.equal(input.inferences[0]?.verification, 'unverified');
  assert.equal(input.inferences[0]?.origin, 'rule');
  assert.equal(input.inferences[0]?.sources[0]?.observationId, 'observation-9');
  assert.equal(input.rules.action, 'close-case');
});

test('model interpretations retain source references without changing facts or actions', async () => {
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
    // Second call: action selection can cite record facts only.
    return Response.json({ message: { content: JSON.stringify({
      action: 'close-case', citations: ['observation-9'],
    }) } });
  };

  const result = await reviewGatewayTriage(input, 'test-model', request, 'support-rules');
  assert.equal(calls, 2);
  assert.deepEqual(result.facts, input.facts);
  assert.equal(input.inferences.length, 0);
  assert.equal(result.inferences[0]?.origin, 'model');
  assert.equal(result.inferences[0]?.verification, 'unverified');
  assert.equal(result.inferences[0]?.sources[0]?.observationId, 'observation-9');
  assert.equal(result.agent.status, 'ready');
  assert.deepEqual(result.agent.recommendation?.citations, ['observation-9']);
});

test('structured conflict reasons stay out of the unstructured extraction path', () => {
  const input = prepareGatewayTriage(ended, [
    { id: '9', evidence: { status: 'conflict', reason: 'accounting-mismatch' } },
  ]);
  assert.deepEqual(input.unstructured, []);
  assert.ok(!input.facts.some((fact) => fact.id.startsWith('evidence-')));
});


test('a real quote supporting a wrong model interpretation never becomes a fact or action citation', async () => {
  const input = prepareGatewayTriage({ ...ended, budgetStatus: 'reserved' }, [
    { id: '12', evidence: { status: 'pending', reason: 'The authorization identifier was NOT reused.' } },
  ]);
  const response = (citeInference: boolean): typeof fetch => async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.format?.properties?.signals) return Response.json({ message: { content: JSON.stringify({
      signals: [{ signal: 'nonce-reused', quote: 'authorization identifier' }],
    }) } });
    return Response.json({ message: { content: JSON.stringify({
      action: 'wait-for-gateway', citations: citeInference ? ['observation-12', 'inference-model-0'] : ['observation-12'],
    }) } });
  };
  const result = await reviewGatewayTriage(input, 'test-model', response(false), 'support-rules');
  assert.equal(result.inferences[0]?.signal, 'nonce-reused');
  assert.equal(result.inferences[0]?.verification, 'unverified');
  assert.equal(result.facts.some((fact) => fact.description.includes('was reused')), false);
  assert.equal(result.rules.action, 'wait-for-gateway');
  assert.equal(result.agent.status, 'ready');
  assert.equal((await reviewGatewayTriage(input, 'test-model', response(true), 'support-rules')).agent.status, 'rejected');
});
