import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGatewayEvidence } from '../src/evaluate-gateway-evidence.js';
import { extractEvidenceRules } from '../src/gateway-evidence-extraction.js';

test('unstructured evidence extraction leaves room for a model that rules cannot cover', async (t) => {
  await t.test('the keyword baseline catches direct phrasings', () => {
    assert.deepEqual(
      extractEvidenceRules('nonce already used for this wallet').map(({ signal }) => signal),
      ['nonce-reused'],
    );
    assert.deepEqual(
      extractEvidenceRules('insufficient funds to cover the settlement').map(({ signal }) => signal),
      ['insufficient-funds'],
    );
  });

  await t.test('the keyword baseline misses paraphrases that mean the same thing', () => {
    assert.deepEqual(
      extractEvidenceRules('the transfer was signed twice with the same identifier'),
      [],
    );
    assert.deepEqual(
      extractEvidenceRules('the wallet ran dry before the batch settled'),
      [],
    );
  });

  await t.test('the held-out set scores the baseline at half recall, all on paraphrases', async () => {
    const result = await evaluateGatewayEvidence(undefined);
    assert.equal(result.totalCases, 20);
    assert.equal(result.rules.recall, 0.5);
    assert.equal(result.rules.precision, 1);
    assert.equal(result.byPhrasing.direct.rules.recall, 1);
    assert.equal(result.byPhrasing.paraphrased.rules.recall, 0);
    assert.equal(result.byPhrasing.paraphrased.cases, 10);
  });
});
