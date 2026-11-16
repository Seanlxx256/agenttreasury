import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGatewayPatterns } from '../src/evaluate-gateway-patterns.js';
import { recognizePatternsRules, recognizePatternsWithModel, systemicPatterns } from '../src/gateway-patterns.js';

const directNonce = [
  { text: 'nonce already used for this wallet', dimension: 'supplier-a' },
  { text: 'nonce already consumed by a prior transfer', dimension: 'supplier-a' },
  { text: 'nonce reused across two transfers', dimension: 'supplier-a' },
];
const paraphraseNonce = [
  { text: 'the transfer was signed twice with the same identifier', dimension: 'supplier-a' },
  { text: 'the same authorization id was submitted again', dimension: 'supplier-a' },
  { text: 'this transfer was replayed under the same signature', dimension: 'supplier-a' },
];

test('the rule baseline counts shared signals and misses paraphrased patterns', () => {
  assert.equal(recognizePatternsRules(directNonce), 'supplier-nonce-bug');
  // The keyword table sees no shared signal, so it reports no pattern.
  assert.equal(recognizePatternsRules(paraphraseNonce), 'no-systemic-pattern');
});

test('the pattern baseline scores two thirds on the mixed dataset', async () => {
  const result = await evaluateGatewayPatterns(undefined);
  assert.equal(result.totalBatches, 6);
  assert.equal(result.rules.correct, 4);
  assert.equal(result.rules.accuracy, 4 / 6);
});

test('the model must return a known systemic pattern', async () => {
  const response = (content: unknown): typeof fetch => async () =>
    Response.json({ message: { content: JSON.stringify(content) } });

  const accepted = await recognizePatternsWithModel(paraphraseNonce, 'test-model',
    response({ pattern: 'supplier-nonce-bug' }));
  assert.equal(accepted.status, 'ready');
  assert.equal(accepted.pattern, 'supplier-nonce-bug');
  assert.ok(systemicPatterns.includes(accepted.pattern));

  const rejected = await recognizePatternsWithModel(paraphraseNonce, 'test-model',
    response({ pattern: 'the-whole-team-is-broken' }));
  assert.equal(rejected.status, 'rejected');
});
