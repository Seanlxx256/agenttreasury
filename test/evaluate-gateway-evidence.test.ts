import assert from 'node:assert/strict';
import { test } from 'node:test';
import { score } from '../src/evaluate-gateway-evidence.js';

test('the evidence scorer dedupes repeated signals so recall cannot exceed 100%', () => {
  // A model that emits the same signal twice (two quotes) used to score 2/1.
  const duplicated = score(['nonce-reused'], ['nonce-reused', 'nonce-reused']);
  assert.equal(duplicated.matched, 1);
  assert.equal(duplicated.expected, 1);
  assert.equal(duplicated.extracted, 1);
  assert.equal(duplicated.recall, 1);
  assert.equal(duplicated.precision, 1);
});

test('the scorer counts the set intersection, not the bag intersection', () => {
  const result = score(
    ['nonce-reused', 'insufficient-funds', 'recipient-not-whitelisted'],
    ['nonce-reused', 'nonce-reused', 'nonce-reused', 'rpc-unavailable'],
  );
  assert.equal(result.matched, 1);
  assert.equal(result.expected, 3);
  assert.equal(result.extracted, 2); // nonce-reused + rpc-unavailable
  assert.equal(result.recall, 1 / 3);
  assert.equal(result.precision, 1 / 2);
});
