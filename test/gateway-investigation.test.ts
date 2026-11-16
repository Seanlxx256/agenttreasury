import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGatewayInvestigation } from '../src/evaluate-gateway-investigation.js';
import {
  investigationKinds, suggestInvestigationsRules, suggestInvestigationsWithModel,
} from '../src/gateway-investigation.js';

const facts = [
  { id: 'observation-42', description: 'Gateway observation: conflict (accounting-mismatch)' },
  { id: 'journal', description: 'A payment journal entry has been posted.' },
];

test('the rule baseline proposes a fixed read-only checklist', () => {
  const suggestions = suggestInvestigationsRules();
  assert.deepEqual(suggestions.map(({ kind }) => kind),
    ['read-chain-receipt', 'read-local-journal', 'compare-transfer-terms']);
  assert.ok(suggestions.every(({ kind }) => investigationKinds.includes(kind)));
});

test('the investigation baseline scores its generic checklist against the labeled checks', async () => {
  const result = await evaluateGatewayInvestigation(undefined);
  assert.equal(result.totalCases, 8);
  // The generic checklist matches 9 of 17 labeled checks across the eight conflicts.
  assert.equal(result.rules.matched, 9);
  assert.equal(result.rules.expected, 17);
  assert.equal(result.rules.recall, 9 / 17);
});

test('the model must propose only known kinds with citable facts', async () => {
  const response = (content: unknown): typeof fetch => async () =>
    Response.json({ message: { content: JSON.stringify(content) } });

  const accepted = await suggestInvestigationsWithModel(facts, 'test-model',
    response({ investigations: [{ kind: 'read-local-journal', citations: ['journal'] }] }));
  assert.equal(accepted.status, 'ready');
  assert.deepEqual(accepted.investigations, [{ kind: 'read-local-journal', citations: ['journal'] }]);

  for (const invalid of [
    { investigations: [{ kind: 'pay-the-merchant', citations: ['journal'] }] },
    { investigations: [{ kind: 'read-local-journal', citations: ['invented'] }] },
    { investigations: 'read-local-journal' },
  ]) {
    const rejected = await suggestInvestigationsWithModel(facts, 'test-model', response(invalid));
    assert.equal(rejected.status, 'rejected');
  }
});
