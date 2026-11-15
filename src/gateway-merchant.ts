import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { isAddress } from 'viem';
import {
  arcGatewayNetwork, decodePaymentHeader, encodePaymentHeader, gatewayTestnetApi,
  recoverGatewayPayer, requestIdPattern, traceOffer,
} from './gateway-x402.js';

const tokenPattern = /^[0-9a-f]{64}$/;
const digestToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function buildGatewayMerchant(pool: Pool, origin: string, recipient: string, request: typeof fetch = fetch) {
  const app = Fastify();
  app.get<{ Params: { requestId: string } }>('/trace/:requestId', async (incoming, reply) => {
    const { requestId } = incoming.params;
    const token = incoming.headers['trace-retrieval-token'];
    if (!requestIdPattern.test(requestId) || typeof token !== 'string' || !tokenPattern.test(token)) {
      return reply.code(404).send({ code: 'DELIVERY_NOT_FOUND' });
    }
    const { rows: [row] } = await pool.query<{ delivery: unknown }>(
      'SELECT delivery FROM gateway_demo_deliveries WHERE request_id = $1 AND token_digest = $2',
      [requestId, digestToken(token)],
    );
    if (row?.delivery == null) return reply.code(404).send({ code: 'DELIVERY_NOT_FOUND' });
    return reply.header('cache-control', 'no-store').send(row.delivery);
  });

  app.post<{ Params: { requestId: string } }>('/trace/:requestId', async (incoming, reply) => {
    const { requestId } = incoming.params;
    if (!requestIdPattern.test(requestId)) return reply.code(400).send({ code: 'INVALID_REQUEST_ID' });

    const offer = traceOffer(`${origin}/trace/${requestId}`, recipient);
    const requirements = offer.accepts[0];
    const header = incoming.headers['payment-signature'];
    if (header === undefined) {
      return reply.code(402).header('payment-required', encodePaymentHeader(offer))
        .send({ code: 'PAYMENT_REQUIRED' });
    }

    const token = incoming.headers['trace-retrieval-token'];
    if (typeof token !== 'string' || !tokenPattern.test(token)) {
      return reply.code(400).send({ code: 'RETRIEVAL_TOKEN_REQUIRED' });
    }
    let payment;
    try {
      payment = decodePaymentHeader(typeof header === 'string' ? header : null);
    } catch {
      return reply.code(400).send({ code: 'INVALID_PAYMENT_SIGNATURE' });
    }
    const auth = payment?.payload?.authorization;
    if (payment?.x402Version !== 2 || payment.resource?.url !== offer.resource.url ||
        typeof auth?.from !== 'string' || !isAddress(auth.from) ||
        typeof auth.to !== 'string' || auth.to.toLowerCase() !== requirements.payTo ||
        auth.value !== requirements.amount ||
        typeof auth.nonce !== 'string' || !/^0x[0-9a-f]{64}$/i.test(auth.nonce) ||
        typeof auth.validAfter !== 'string' || !/^\d{1,78}$/.test(auth.validAfter) ||
        typeof auth.validBefore !== 'string' || !/^\d{1,78}$/.test(auth.validBefore) ||
        typeof payment.payload.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(payment.payload.signature)) {
      return reply.code(400).send({ code: 'INVALID_AUTHORIZATION' });
    }
    const recovered = await recoverGatewayPayer(auth, payment.payload.signature).catch(() => null);
    if (recovered?.toLowerCase() !== auth.from.toLowerCase()) {
      return reply.code(400).send({ code: 'INVALID_AUTHORIZATION' });
    }

    const claim = await pool.query(
      'INSERT INTO gateway_demo_deliveries (request_id, nonce, token_digest) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [requestId, auth.nonce.toLowerCase(), digestToken(token)],
    );
    if (claim.rowCount === 0) return reply.code(409).send({ code: 'PAYMENT_ALREADY_SUBMITTED' });

    let settlement;
    try {
      const response = await request(`${gatewayTestnetApi}/settle`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paymentPayload: {
            x402Version: 2, resource: offer.resource, accepted: requirements,
            payload: { authorization: auth, signature: payment.payload.signature },
          },
          paymentRequirements: requirements,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return reply.code(502).send({ code: 'GATEWAY_SETTLEMENT_UNAVAILABLE' });
      }
      settlement = await response.json();
    } catch {
      return reply.code(502).send({ code: 'GATEWAY_SETTLEMENT_UNAVAILABLE' });
    }
    if (settlement?.success !== true) {
      const reason = typeof settlement?.errorReason === 'string' ? settlement.errorReason : undefined;
      return reply.code(402).send({ code: 'GATEWAY_PAYMENT_REJECTED', reason });
    }
    if (settlement.network !== arcGatewayNetwork || typeof settlement.payer !== 'string' ||
        settlement.payer.toLowerCase() !== auth.from.toLowerCase() ||
        typeof settlement.transaction !== 'string' || !settlement.transaction) {
      return reply.code(502).send({ code: 'INVALID_GATEWAY_RECEIPT' });
    }

    const delivery = {
      requestId,
      nonce: auth.nonce.toLowerCase(),
      gatewayReference: settlement.transaction,
      trace: { source: 'fixture', calls: [{ type: 'CALL', error: 'execution reverted' }] },
    };
    await pool.query('UPDATE gateway_demo_deliveries SET delivery = $2 WHERE request_id = $1',
      [requestId, JSON.stringify(delivery)]);
    return reply.header('payment-response', encodePaymentHeader(settlement)).send(delivery);
  });
  return app;
}
