import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeGatewayPayment } from '../src/gateway-reconciliation.js';

const expected = {
  nonce: `0x${'a'.repeat(64)}`,
  payer: `0x${'1'.repeat(40)}`,
  recipient: `0x${'2'.repeat(40)}`,
  amountUnits: '1000',
};
const batchHash = `0x${'b'.repeat(64)}`;
const transfer = {
  id: '78436d0c-f128-4df4-bbb8-a62bed132dcc',
  status: 'confirmed',
  nonce: expected.nonce,
  fromAddress: expected.payer,
  toAddress: expected.recipient,
  amount: expected.amountUnits,
  sendingNetwork: 'eip155:5042002',
  recipientNetwork: 'eip155:5042002',
  token: 'USDC',
  txHash: batchHash,
};

test('Gateway lookup distinguishes a missing transfer, an accepted payment, and a confirmed charge', async () => {
  assert.deepEqual(await observeGatewayPayment(expected, async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://gateway-api-testnet.circle.com');
    assert.equal(url.searchParams.get('network'), 'eip155:5042002');
    assert.equal(url.searchParams.get('nonce'), expected.nonce);
    return Response.json({ transfers: [] });
  }), { status: 'unknown' });
  assert.deepEqual(await observeGatewayPayment(expected, async () => Response.json({
    transfers: [{ ...transfer, status: 'received', txHash: null }],
  })), { status: 'pending', id: transfer.id, txHash: null });
  assert.deepEqual(await observeGatewayPayment(expected, async () => Response.json({
    transfers: [transfer],
  })), { status: 'charged', id: transfer.id, txHash: batchHash });
});

test('Gateway lookup requires matching evidence before reporting a failed or charged transfer', async () => {
  const failed = { ...transfer, status: 'failed', txHash: null };
  assert.deepEqual(await observeGatewayPayment(expected, async () => Response.json({
    transfers: [failed],
  })), { status: 'failed', id: transfer.id, txHash: null });
  assert.deepEqual(await observeGatewayPayment(expected, async () => Response.json({
    transfers: [{ ...failed, amount: '999' }],
  })), { status: 'conflict', reason: 'transfer-mismatch' });
  assert.deepEqual(await observeGatewayPayment(expected, async () => Response.json({
    transfers: [transfer, { ...transfer, id: 'other-transfer' }],
  })), { status: 'conflict', reason: 'multiple-transfers' });
  await assert.rejects(observeGatewayPayment(expected, async () => Response.json({
    transfers: [{ ...transfer, txHash: null }],
  })), /missing a valid batch hash/);
  await assert.rejects(observeGatewayPayment(expected, async () => new Response(null, {
    status: 503,
  })), /HTTP 503/);
});
