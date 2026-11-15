import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareGatewayTriage, reviewGatewayTriage } from '../src/gateway-triage.js';

const purchase = {
  budgetStatus: 'spent', reviewRequired: false, buyerHasDelivery: false,
  sellerHasDelivery: true, journal: { transferId: 'sensitive-transfer-reference' },
};
const charged = { id: '42', evidence: { status: 'charged' } };

test('triage preserves a payment conflict after a Gateway outage', () => {
  const input = prepareGatewayTriage(purchase, [
    { id: '44', evidence: { status: 'unavailable' } },
    { id: '43', evidence: { status: 'conflict', reason: 'accounting-mismatch' } },
    charged,
  ]);
  assert.equal(input.rules.action, 'review-conflict');
  assert.deepEqual(input.rules.citations, ['observation-43']);
});

test('triage accepts only permitted actions with matching evidence citations', async () => {
  const input = prepareGatewayTriage(purchase, [charged]);
  const suggestion = {
    action: 'retrieve-delivery', rationale: 'The seller has a saved trace for the confirmed purchase.',
    citations: ['observation-42', 'buyer-delivery', 'seller-delivery'],
  };
  const localModel = (value: unknown): typeof fetch => async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const requestBody = JSON.parse(String(init?.body));
    assert.equal(requestBody.tools, undefined);
    assert.doesNotMatch(JSON.stringify(requestBody), /sensitive-transfer-reference/);
    return Response.json({ message: { content: JSON.stringify(value) } });
  };
  const accepted = await reviewGatewayTriage(input, 'test-model', localModel(suggestion));
  assert.deepEqual(accepted.agent, { status: 'ready', model: 'test-model', recommendation: suggestion });

  for (const invalid of [
    { ...suggestion, action: 'retry-payment' },
    { ...suggestion, citations: ['observation-42'] },
    { ...suggestion, citations: [...suggestion.citations, 'invented-observation'] },
  ]) {
    const result = await reviewGatewayTriage(input, 'test-model', localModel(invalid));
    assert.deepEqual(result.agent, { status: 'rejected' });
    assert.equal(result.rules.action, 'retrieve-delivery');
  }
});
