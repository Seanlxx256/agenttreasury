import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { transaction } from './db.js';
import { checkDelivery } from './refund-requests.js';
import type { Pool } from 'pg';
import type { Hash } from 'viem';
import { baseSepoliaUsdc } from './base-settlement.js';
import type { RefundChain } from './refunds.js';
import { TransactionReceiptNotFoundError } from 'viem';

export const marketPrice = '2000';
export const marketNetwork = 'eip155:84532';

export interface MerchantConfig {
  endpoint: string;
  recipient: string;
  secret: string;
}

export interface DeliveryProof {
  intentId: string;
  payer: string;
  transactionHash: Hash;
}

export function deliverySignature(config: MerchantConfig, proof: DeliveryProof) {
  return createHmac('sha256', config.secret).update(JSON.stringify([
    'market-data-v1', config.endpoint, config.recipient.toLowerCase(),
    proof.intentId, proof.payer, proof.transactionHash,
  ])).digest('hex');
}

export function merchantConfig(): MerchantConfig {
  const { MERCHANT_ENDPOINT: endpoint, MERCHANT_RECIPIENT: recipient, MERCHANT_DELIVERY_SECRET: secret } = process.env;
  if (!endpoint || !recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient) ||
      !secret || secret.length < 32) {
    throw new Error('Configure MERCHANT_ENDPOINT, MERCHANT_RECIPIENT and MERCHANT_DELIVERY_SECRET');
  }
  const url = new URL(endpoint);
  if (url.href !== endpoint || url.pathname !== '/market-data' || url.search || url.hash ||
      url.username || url.password || (url.protocol !== 'https:' &&
      !/^http:\/\/127\.0\.0\.1:[0-9]+\/market-data$/.test(endpoint))) {
    throw new Error('Merchant endpoint must be a canonical HTTPS market-data URL or an explicit loopback URL');
  }
  return { endpoint, recipient: recipient.toLowerCase(), secret };
}

export function buildMerchant(pool: Pool, config: MerchantConfig, chain: RefundChain) {
  const app = Fastify({ bodyLimit: 4096, ajv: { customOptions: { removeAdditional: false } } });
  const quote = Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: config.endpoint, description: 'Sample German camping lantern market data' },
    accepts: [{
      scheme: 'exact', network: marketNetwork, asset: baseSepoliaUsdc, payTo: config.recipient,
      amount: marketPrice, maxTimeoutSeconds: 90,
      extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
    }],
  })).toString('base64');
  app.get('/market-data', async (_, reply) =>
    reply.code(402).header('payment-required', quote).send({ code: 'PAYMENT_REQUIRED' }));

  app.post<{ Body: DeliveryProof }>('/market-data', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['intentId', 'payer', 'transactionHash'],
    properties: {
      intentId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
      payer: { type: 'string', pattern: '^0x[0-9a-f]{40}$' },
      transactionHash: { type: 'string', pattern: '^0x[0-9a-f]{64}$' },
    },
  } } }, async (request, reply) => {
    const proof = request.body;
    const signature = request.headers['delivery-signature'];
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(deliverySignature(config, proof), 'hex'))) {
      return reply.code(401).send({ code: 'INVALID_DELIVERY_SIGNATURE' });
    }

    async function existingDelivery() {
      const { rows: [stored] } = await pool.query<{ intent_id: string; transaction_hash: string; result: unknown }>(
        'SELECT intent_id, transaction_hash, result FROM merchant_deliveries WHERE intent_id = $1 OR transaction_hash = $2 ORDER BY intent_id = $1 DESC LIMIT 1',
        [proof.intentId, proof.transactionHash],
      );
      return stored;
    }

    function sendStored(stored: NonNullable<Awaited<ReturnType<typeof existingDelivery>>>) {
      if (stored.intent_id !== proof.intentId || stored.transaction_hash !== proof.transactionHash) {
        return reply.code(409).send({ code: 'PAYMENT_PROOF_ALREADY_REDEEMED' });
      }
      return reply.send(stored.result);
    }

    const existing = await existingDelivery();
    if (existing) return sendStored(existing);

    let receipt;
    try {
      receipt = await chain.receipt(proof.transactionHash);
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return reply.code(409).send({ code: 'PAYMENT_NOT_FINALIZED' });
      throw error;
    }
    if (receipt.blockNumber > await chain.finalized()) {
      return reply.code(409).send({ code: 'PAYMENT_NOT_FINALIZED' });
    }
    if (receipt.status !== 'success' || (await chain.blockHash(receipt.blockNumber)) !== receipt.blockHash ||
        !receipt.logs.some((log) => log.address.toLowerCase() === baseSepoliaUsdc &&
          log.from.toLowerCase() === proof.payer && log.to.toLowerCase() === config.recipient &&
          log.amount === BigInt(marketPrice))) {
      return reply.code(422).send({ code: 'INVALID_PAYMENT_PROOF' });
    }

    const result = { market: 'DE', category: 'camping lanterns', currency: 'EUR',
      sample: true, observations: [{ segment: 'entry level', medianPrice: 19.99 }, { segment: 'outdoor', medianPrice: 39.99 }] };
    const outcome = await transaction(pool, async (client) => {
      const blocked = await checkDelivery(client, proof.intentId, proof.transactionHash, proof.payer);
      if (blocked) return blocked;
      const { rowCount } = await client.query(`
        INSERT INTO merchant_deliveries (intent_id, transaction_hash, result)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
      `, [proof.intentId, proof.transactionHash, result]);
      return rowCount === 1 ? 'DELIVERED' : 'DELIVERY_CONFLICT';
    });
    if (outcome === 'DELIVERED') return reply.send(result);
    const winner = await existingDelivery();
    if (winner) return sendStored(winner);
    return reply.code(409).send({ code: outcome });
  });
  return app;
}
