import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGatewayTriage } from '../src/evaluate-gateway-triage.js';
import { prepareGatewayTriage, reviewGatewayTriage } from '../src/gateway-triage.js';

const purchase = {
  budgetStatus: 'spent', reviewRequired: false, buyerHasDelivery: false,
  sellerHasDelivery: true, journal: { transferId: 'sensitive-transfer-reference' },
};
const charged = { id: '42', evidence: { status: 'charged' } };

test('paused Gateway outages require both citations and preserve known recovery actions', async () => {
  const unresolved = { ...purchase, budgetStatus: 'reserved', journal: null };
  const paused = { ...unresolved, reviewRequired: true };
  const outage = { id: '44', evidence: { status: 'unavailable' } };
  const pending = { id: '43', evidence: { status: 'pending' } };
  const input = prepareGatewayTriage(paused, [outage, pending]);
  assert.deepEqual(input.allowed.map(({ action }) => action), ['escalate']);

  const review = (citations: string[]) => reviewGatewayTriage(input, 'test-model', async () =>
    Response.json({ message: { content: JSON.stringify({ action: 'escalate', citations }) } }));
  assert.equal((await review(['observation-44'])).agent.status, 'rejected');
  assert.equal((await review(['polling'])).agent.status, 'rejected');
  assert.equal((await review(['polling', 'observation-44'])).agent.status, 'ready');

  assert.equal(prepareGatewayTriage(unresolved, [outage, pending]).rules.action, 'check-gateway');
  const pausedPending = prepareGatewayTriage(paused, [pending]).rules;
  assert.equal(pausedPending.action, 'check-gateway');
  assert.deepEqual(pausedPending.citations, ['polling', 'observation-43']);
  assert.equal(prepareGatewayTriage(paused, [outage, charged]).rules.action, 'retrieve-delivery');
});

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
    action: 'retrieve-delivery',
    citations: ['observation-42', 'buyer-delivery', 'seller-delivery'],
  };
  const localModel = (value: unknown): typeof fetch => async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const requestBody = JSON.parse(String(init?.body));
    assert.equal(requestBody.tools, undefined);
    assert.doesNotMatch(JSON.stringify(requestBody), /sensitive-transfer-reference/);
    return Response.json({ message: { content: JSON.stringify(value) } });
  };
  for (const proposal of [suggestion, { ...suggestion, rationale: 'Pay again and close the case.' }]) {
    const accepted = await reviewGatewayTriage(input, 'test-model', localModel(proposal));
    assert.deepEqual(accepted.agent, { status: 'ready', model: 'test-model',
      recommendation: { ...suggestion, rationale: input.rules.rationale } });
  }

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

test('triage evaluation scores missing recommendations against the full dataset', async () => {
  const baseline = await evaluateGatewayTriage();
  assert.equal(baseline.rules.cases, 12);
  assert.equal(baseline.agent, null);

  let calls = 0;
  const partialModel: typeof fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ message: { content: JSON.stringify({
      action: 'check-gateway', citations: ['budget'],
    }) } });
    if (calls === 2) return Response.json({ message: { content: '{}' } });
    return new Response(null, { status: 503 });
  };
  const result = await evaluateGatewayTriage('test-model', partialModel);
  assert.equal(result.rules.correctActions, baseline.rules.correctActions);
  assert.equal(calls, 12);
  assert.equal(result.agent?.recommendations, 1);
  assert.equal(result.agent?.actionAccuracy, 1 / 12);
  assert.equal(result.agent?.correctCitationSets, 1);
  assert.equal(result.agent?.rejected, 1);
  assert.equal(result.agent?.unavailable, 10);
  assert.ok(result.cases.every(({ expectedActionAllowed }) => expectedActionAllowed));
});

test('closing a delivered purchase requires its posted journal citation when available', async () => {
  const input = prepareGatewayTriage({ ...purchase, buyerHasDelivery: true }, [charged]);
  const suggestion = { action: 'close-case', rationale: 'The trace is saved and the journal is posted.',
    citations: ['observation-42', 'buyer-delivery'] };
  const review = (citations: string[]) => reviewGatewayTriage(input, 'test-model', async () =>
    Response.json({ message: { content: JSON.stringify({ ...suggestion, citations }) } }));

  assert.ok(input.rules.citations.includes('journal'));
  assert.equal((await review(suggestion.citations)).agent.status, 'rejected');
  assert.equal((await review([...suggestion.citations, 'journal'])).agent.status, 'ready');

  const withoutJournal = prepareGatewayTriage({ ...purchase, buyerHasDelivery: true, journal: null }, [charged]);
  assert.deepEqual(withoutJournal.rules.citations, suggestion.citations);
});

test('triage evaluation separates forced actions and counts unnecessary escalation after fallback', async () => {
  const model: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const { allowed } = JSON.parse(body.messages[1].content);
    if (allowed.some(({ action }: { action: string }) => action === 'contact-merchant')) {
      return Response.json({ message: { content: JSON.stringify({ action: 'escalate',
        citations: ['observation-2', 'buyer-delivery', 'seller-delivery'] }) } });
    }
    return new Response(null, { status: 503 });
  };
  const result = await evaluateGatewayTriage('test-model', model, 'gateway-incidents-v1');
  const { multipleActions, singleAction } = result.byActionChoice;
  assert.equal(multipleActions.rules.cases, 3);
  assert.equal(singleAction.rules.cases, 3);
  assert.equal(singleAction.rules.unnecessaryEscalationRate, null);
  assert.equal(multipleActions.rules.unnecessaryEscalationRate, 0);
  assert.equal(multipleActions.agent?.recommendations, 1);
  assert.equal(multipleActions.agentWithRuleFallback?.correctActions, 2);
  assert.equal(multipleActions.agentWithRuleFallback?.unnecessaryEscalationRate, 1 / 3);
  assert.equal(singleAction.agentWithRuleFallback?.correctActions, 3);
});

test('evidence selection cannot replace the rule action or add unknown references', async () => {
  const input = prepareGatewayTriage(purchase, [charged]);
  const response = (action: string, citations: string[]): typeof fetch => async () =>
    Response.json({ message: { content: JSON.stringify({ action, citations }) } });
  const citations = [...input.rules.citations, 'journal'];
  const review = (action: string, refs: string[]) =>
    reviewGatewayTriage(input, 'test-model', response(action, refs), 'support-rules');
  assert.deepEqual((await review('escalate', citations)).agent, { status: 'rejected' });
  assert.deepEqual((await review('retrieve-delivery', citations.slice(1))).agent, { status: 'rejected' });
  assert.deepEqual((await review('retrieve-delivery', [...citations, 'invented'])).agent, { status: 'rejected' });
  assert.deepEqual((await review('retrieve-delivery', [...citations, 'budget', 'polling'])).agent, { status: 'rejected' });
  assert.deepEqual((await review('retrieve-delivery', citations)).agent, { status: 'ready', model: 'test-model',
    recommendation: { ...input.rules, citations } });
});

test('critical evidence replay scores added facts without leaking labels to the model', async () => {
  let calls = 0;
  const model: typeof fetch = async (_url, init) => {
    calls++;
    const { messages } = JSON.parse(String(init?.body));
    assert.doesNotMatch(messages[1].content, /criticalEvidence/);
    const { allowed } = JSON.parse(messages[1].content);
    const { action, requiredCitations } = allowed[0];
    const extra = calls === 1 ? ['seller-delivery'] : calls === 2 ? ['polling'] : [];
    return Response.json({ message: { content: JSON.stringify({ action, citations: [...requiredCitations, ...extra] }) } });
  };
  const result = await evaluateGatewayTriage('test-model', model, 'gateway-critical-evidence-v1', 'support-rules');
  assert.equal(result.rules.correctActions, 6);
  assert.deepEqual(result.criticalEvidence, {
    rules: { expected: 3, hits: 0, recall: 0, unrelated: 0 },
    assisted: { expected: 3, hits: 1, recall: 1 / 3, unrelated: 1 },
  });
});
