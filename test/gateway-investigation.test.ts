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

test('the rule baseline maps conflict signals to targeted checks and falls back generically', () => {
  const generic = suggestInvestigationsRules();
  assert.deepEqual(generic.map(({ kind }) => kind),
    ['read-chain-receipt', 'read-local-journal', 'compare-transfer-terms']);
  assert.ok(generic.every(({ kind }) => investigationKinds.includes(kind)));

  const targeted = suggestInvestigationsRules([
    { id: 'observation-42', description: 'Gateway observation: conflict (accounting-mismatch)' },
    { id: 'journal', description: 'A payment journal entry has been posted.' },
  ]);
  assert.deepEqual(targeted.map(({ kind }) => kind).sort(),
    ['compare-transfer-terms', 'read-local-journal']);
});

test('the mapped baseline hits every labeled check', async () => {
  const result = await evaluateGatewayInvestigation(undefined);
  assert.equal(result.totalCases, 8);
  assert.equal(result.rules.matched, 17);
  assert.equal(result.rules.expected, 17);
  assert.equal(result.rules.recall, 1);
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
