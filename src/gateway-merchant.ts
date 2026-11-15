import Fastify from 'fastify';
import { isAddress } from 'viem';
import {
  arcGatewayNetwork, decodePaymentHeader, encodePaymentHeader, gatewayTestnetApi,
  requestIdPattern, traceOffer,
} from './gateway-x402.js';

export function buildGatewayMerchant(origin: string, recipient: string, request: typeof fetch = fetch) {
  const app = Fastify();
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
        auth.value !== requirements.amount || !/^0x[0-9a-f]{64}$/i.test(auth.nonce) ||
        !/^0x[0-9a-f]{130}$/i.test(payment.payload.signature)) {
      return reply.code(400).send({ code: 'INVALID_AUTHORIZATION' });
    }

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

    return reply.header('payment-response', encodePaymentHeader(settlement)).send({
      requestId,
      gatewayReference: settlement.transaction,
      trace: { source: 'fixture', calls: [{ type: 'CALL', error: 'execution reverted' }] },
    });
  });
  return app;
}
