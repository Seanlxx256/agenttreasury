import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import {
  decodePaymentHeader, encodePaymentHeader, gatewayAuthorizationTypes,
  gatewayDomain, gatewayTracePrice, gatewayValidity, traceOffer,
} from './gateway-x402.js';

type Authorization = {
  from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex;
};

type SigningRequest = {
  domain: typeof gatewayDomain;
  types: typeof gatewayAuthorizationTypes;
  primaryType: 'TransferWithAuthorization';
  message: Authorization;
};

type Purchase = { requestId: string; endpoint: string; payer: Address; recipient: Address };
type StoredPurchase = {
  endpoint: string; payer: string; recipient: string; nonce: Hex; amount_units: string; delivery: unknown;
};

export async function purchaseGatewayTrace(
  pool: Pool,
  purchase: Purchase,
  sign: (typedData: SigningRequest) => Promise<Hex>,
  request: typeof fetch = fetch,
) {
  const { requestId, endpoint, payer, recipient } = purchase;
  const findExisting = async () => {
    const { rows: [row] } = await pool.query<StoredPurchase>(
      'SELECT endpoint, payer, recipient, nonce, amount_units, delivery FROM gateway_demo_purchases WHERE request_id = $1',
      [requestId],
    );
    if (!row) return undefined;
    if (row.endpoint !== endpoint || row.payer !== payer.toLowerCase() ||
        row.recipient !== recipient.toLowerCase() || row.amount_units !== gatewayTracePrice) {
      throw new Error('Request ID already belongs to different payment terms');
    }
    return { status: row.delivery === null ? 'submission-unknown' : 'delivered', nonce: row.nonce, delivery: row.delivery };
  };
  const existing = await findExisting();
  if (existing) return existing;

  const offer = traceOffer(endpoint, recipient);
  const requirements = offer.accepts[0];
  const quoteResponse = await request(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  await quoteResponse.body?.cancel();
  if (quoteResponse.status !== 402) throw new Error('Expected an x402 quote');
  const quote = decodePaymentHeader(quoteResponse.headers.get('payment-required'));
  const matches = Array.isArray(quote?.accepts) && quote.accepts.some((option: typeof requirements) =>
    option?.scheme === requirements.scheme && option.network === requirements.network &&
    option.asset?.toLowerCase() === requirements.asset && option.payTo?.toLowerCase() === requirements.payTo &&
    option.amount === requirements.amount && option.maxTimeoutSeconds === requirements.maxTimeoutSeconds &&
    option.extra?.name === requirements.extra.name && option.extra.version === requirements.extra.version &&
    option.extra.verifyingContract?.toLowerCase() === requirements.extra.verifyingContract);
  if (quote?.x402Version !== 2 || quote.resource?.url !== endpoint || !matches) {
    throw new Error('Gateway quote differs from the approved terms');
  }

  const authorization: Authorization = {
    from: payer, to: recipient, value: requirements.amount, validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + gatewayValidity),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  // Only the process that inserts this row may sign and submit. Never replay an ambiguous POST.
  const claim = await pool.query(
    `INSERT INTO gateway_demo_purchases (request_id, endpoint, nonce, payer, recipient, amount_units)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (request_id) DO NOTHING`,
    [requestId, endpoint, authorization.nonce, payer.toLowerCase(), recipient.toLowerCase(), requirements.amount],
  );
  if (claim.rowCount === 0) {
    const concurrent = await findExisting();
    if (!concurrent) throw new Error('Concurrent signing failed. Retry the same request ID.');
    return concurrent;
  }

  const typedData = {
    domain: gatewayDomain, types: gatewayAuthorizationTypes,
    primaryType: 'TransferWithAuthorization', message: authorization,
  } as const;
  let signature: Hex;
  try {
    signature = await sign(typedData);
    const recovered = await recoverTypedDataAddress({
      ...typedData, signature,
      message: {
        ...authorization, value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore),
      },
    });
    if (recovered.toLowerCase() !== payer.toLowerCase()) throw new Error('Unexpected signing address');
  } catch (error) {
    // The paid request has not been issued. This ID can safely retry signing.
    await pool.query('DELETE FROM gateway_demo_purchases WHERE request_id = $1 AND nonce = $2',
      [requestId, authorization.nonce]);
    throw error;
  }

  try {
    const response = await request(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'payment-signature': encodePaymentHeader({
        x402Version: 2, resource: offer.resource, accepted: requirements,
        payload: { authorization, signature },
      }) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Merchant returned HTTP ${response.status}`);
    }
    const delivery = await response.json();
    if (delivery?.requestId !== requestId || typeof delivery.gatewayReference !== 'string' ||
        !delivery.gatewayReference || delivery.trace?.source !== 'fixture') {
      throw new Error('Merchant did not return a matching trace');
    }
    await pool.query('UPDATE gateway_demo_purchases SET delivery = $2 WHERE request_id = $1',
      [requestId, JSON.stringify(delivery)]);
    return { status: 'delivered', nonce: authorization.nonce, delivery };
  } catch {
    return { status: 'submission-unknown', nonce: authorization.nonce, delivery: null };
  }
}
