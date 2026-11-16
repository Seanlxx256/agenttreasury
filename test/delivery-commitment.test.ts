import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  traceDeliveryCommitment, verifyDeliveryCommitment, type DeliveryCommitment,
} from '../src/delivery-commitment.js';

test('delivery commitment verification', async (t) => {
  await t.test('accepts a trace whose calls all succeeded', () => {
    const delivery = { trace: { source: 'fixture', calls: [{ type: 'CALL', status: 'success' }] } };
    const result = verifyDeliveryCommitment(delivery, traceDeliveryCommitment);
    assert.equal(result.satisfied, true);
    assert.deepEqual(result.violations, []);
  });

  await t.test('accepts a call that diagnosed a reverted target transaction', () => {
    // Reporting the revert is a correct diagnostic delivery, not a breach.
    const delivery = { trace: { source: 'fixture', calls: [{ type: 'CALL', error: 'execution reverted' }] } };
    const result = verifyDeliveryCommitment(delivery, traceDeliveryCommitment);
    assert.equal(result.satisfied, true);
    assert.deepEqual(result.violations, []);
  });

  await t.test('flags a delivery with no calls', () => {
    const result = verifyDeliveryCommitment({ trace: { source: 'fixture' } }, traceDeliveryCommitment);
    assert.equal(result.satisfied, false);
    assert.deepEqual(result.violations, ['trace.calls is empty or missing']);
  });

  await t.test('flags a call of the wrong type', () => {
    const delivery = { trace: { source: 'fixture', calls: [{ type: 'WRONG_TYPE', status: 'success' }] } };
    const result = verifyDeliveryCommitment(delivery, traceDeliveryCommitment);
    assert.equal(result.satisfied, false);
    assert.deepEqual(result.violations, ['trace.calls[0] type WRONG_TYPE != CALL']);
  });

  await t.test('flags a call with no terminal result', () => {
    const delivery = { trace: { source: 'fixture', calls: [{ type: 'CALL' }] } };
    const result = verifyDeliveryCommitment(delivery, traceDeliveryCommitment);
    assert.equal(result.satisfied, false);
    assert.deepEqual(result.violations, ['trace.calls[0] has no terminal result']);
  });

  await t.test('flags a call whose outcome contradicts a pinned status', () => {
    const commitment: DeliveryCommitment = { trace: { calls: [{ type: 'CALL', status: 'reverted' }] } };
    const delivery = { trace: { source: 'fixture', calls: [{ type: 'CALL', status: 'success' }] } };
    const result = verifyDeliveryCommitment(delivery, commitment);
    assert.equal(result.satisfied, false);
    assert.deepEqual(result.violations, ['trace.calls[0] status success != reverted']);
  });

  await t.test('treats an errored call as status reverted under a pinned status', () => {
    const commitment: DeliveryCommitment = { trace: { calls: [{ type: 'CALL', status: 'reverted' }] } };
    const delivery = { trace: { source: 'fixture', calls: [{ type: 'CALL', error: 'execution reverted' }] } };
    const result = verifyDeliveryCommitment(delivery, commitment);
    assert.equal(result.satisfied, true);
    assert.deepEqual(result.violations, []);
  });
});
