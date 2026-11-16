import assert from 'node:assert/strict';
import { test } from 'node:test';
import { traceDeliveryCommitment, verifyDeliveryCommitment } from '../src/delivery-commitment.js';

test('delivery commitment verification', async (t) => {
  await t.test('accepts a trace whose calls all succeeded', () => {
    const delivery = { trace: { source: 'fixture', calls: [{ type: 'CALL', status: 'success' }] } };
    const result = verifyDeliveryCommitment(delivery, traceDeliveryCommitment);
    assert.equal(result.satisfied, true);
    assert.deepEqual(result.violations, []);
  });

  await t.test('flags a call that errored', () => {
    const delivery = { trace: { source: 'fixture', calls: [{ type: 'CALL', error: 'execution reverted' }] } };
    const result = verifyDeliveryCommitment(delivery, traceDeliveryCommitment);
    assert.equal(result.satisfied, false);
    assert.deepEqual(result.violations, ['trace.calls[0] errored: execution reverted']);
  });

  await t.test('flags a delivery with no calls', () => {
    const result = verifyDeliveryCommitment({ trace: { source: 'fixture' } }, traceDeliveryCommitment);
    assert.equal(result.satisfied, false);
    assert.deepEqual(result.violations, ['trace.calls is empty or missing']);
  });
});
