import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractClaimMaterials } from '../src/gateway-claim-materials.js';
import { statementSources } from '../src/gateway-case-packet.js';
import { claimAssessmentCases } from '../src/claim-assessment-cases.js';

test('explicit evidence values are source-bound and deduplicated; unknown formats remain unextracted', () => {
  const sources = statementSources({ customerStatement: 'Invoice INV_903. Error code X_772. I expect readable JSON. On Base Sepolia at 14:32 UTC. Amount 12.75 USDC. Invoice INV_903.', merchantStatement: '' });
  const values = extractClaimMaterials([...sources, { id: 'private', kind: 'local-record', locator: 'db', data: { text: '99.99 USDC' } }]);
  for (const value of values) assert.ok(String(sources[0]!.data.text).includes(value.quote));
  assert.equal(values.filter((m) => m.field === 'order-reference').length, 1);
  assert.ok(values.some((m) => m.quote === 'Base Sepolia')); assert.ok(values.some((m) => m.quote === 'X_772'));
  assert.ok(values.some((m) => m.quote === 'readable JSON')); assert.ok(values.every((m) => m.sourceId !== 'private'));
  assert.deepEqual(extractClaimMaterials(statementSources({ customerStatement: 'Please provide an amount and a transaction hash.', merchantStatement: '' })), []);
});

test('structural types reject addresses as hashes, preserve party boundaries, and cap total evidence', () => {
  const sources = statementSources({ customerStatement: `refund transaction 0x${'a'.repeat(40)}; recipient 0x${'b'.repeat(64)}`,
    merchantStatement: 'Order M-902 on Solana, 4.00 USDC.' });
  const values = extractClaimMaterials(sources);
  assert.ok(values.every((v) => !['refund-hash', 'recipient'].includes(v.field)));
  assert.ok(values.every((v) => v.sourceId === 'statement-merchant'));
  const many = statementSources({ customerStatement: Array.from({ length: 110 }, (_, i) => `Order R-${1000 + i}.`).join(' '), merchantStatement: '' });
  assert.equal(extractClaimMaterials(many).length, 100);
});

test('material development labels measure parser coverage separately from model output', () => {
  let expected = 0; let found = 0; let unsupported = 0;
  for (const sample of claimAssessmentCases()) {
    const candidates = extractClaimMaterials(statementSources(sample.input));
    const supports = (c: typeof candidates[number], l: typeof candidates[number]) => c.field === l.field && c.sourceId === l.sourceId && c.quote.includes(l.quote);
    expected += sample.expected.materials.length;
    found += sample.expected.materials.filter((l) => candidates.some((c) => supports(c, l))).length;
    unsupported += candidates.filter((c) => !sample.expected.materials.some((l) => supports(c, l))).length;
  }
  assert.equal(expected, 13); assert.equal(found, 13); assert.equal(unsupported, 0);
});
