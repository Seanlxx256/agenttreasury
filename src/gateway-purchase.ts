import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { Address, Hex } from 'viem';
import { reserveAmount } from './budget.js';
import { transaction } from './db.js';
import {
  checkGatewayBudget, lockGatewayGrant, releaseUnsubmittedGatewayPurchase, type GatewayTaskCredentials,
} from './gateway-budget.js';
import { checkGatewayPayment } from './gateway-payment-evidence.js';
import { PaymentError, tokenDigest } from './payments.js';
import {
  decodePaymentHeader, encodePaymentHeader, gatewayAuthorizationTypes,
  gatewayChainName, gatewayNetworkConfig, gatewayTracePrice, gatewayValidity,
  recoverGatewayPayer, traceOffer, type GatewayAuthorization, type GatewayNetworkName,
} from './gateway-x402.js';

type SigningRequest = {
  domain: ReturnType<typeof gatewayNetworkConfig>['domain'];
  types: typeof gatewayAuthorizationTypes;
  primaryType: 'TransferWithAuthorization';
  message: GatewayAuthorization;
};

type Purchase = {
  requestId: string; endpoint: string; payer: Address; recipient: Address; network?: GatewayNetworkName;
  task?: GatewayTaskCredentials;
};
type StoredPurchase = {
  endpoint: string; payer: string; recipient: string; nonce: Hex; amount_units: string; delivery: unknown;
  network: GatewayNetworkName;
  retrieval_token: string | null;
  task_id: string | null;
  budget_status: 'reserved' | 'spent' | 'released' | null;
  owner: boolean;
};

async function receiveDelivery(response: Response, requestId: string, nonce: Hex) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Merchant returned HTTP ${response.status}`);
  }
  const delivery = await response.json();
  if (delivery?.requestId !== requestId || delivery.nonce !== nonce ||
      typeof delivery.gatewayReference !== 'string' || !delivery.gatewayReference ||
      delivery.trace?.source !== 'fixture') {
    throw new Error('Merchant did not return a matching trace');
  }
  return delivery;
}

export async function purchaseGatewayTrace(
  pool: Pool,
  purchase: Purchase,
  sign: (typedData: SigningRequest) => Promise<Hex>,
  request: typeof fetch = fetch,
  gatewayRequest: typeof fetch = fetch,
) {
  const { requestId, endpoint, payer, recipient, network = gatewayChainName, task } = purchase;
  const config = gatewayNetworkConfig(network);
  const findExisting = async () => {
    const { rows: [row] } = await pool.query<StoredPurchase>(
      `SELECT p.*, EXISTS (
         SELECT 1 FROM research_tasks t JOIN agents a ON a.id = t.agent_id
         WHERE t.id = p.task_id AND a.token_digest = $2 AND a.enabled
       ) AS owner FROM gateway_demo_purchases p WHERE p.request_id = $1`,
      [requestId, task ? tokenDigest(task.agentToken) : null],
    );
    if (!row) return undefined;
    if (row.task_id && (row.task_id !== task?.taskId || !row.owner)) {
      throw new PaymentError(403, 'GATEWAY_TASK_NOT_ALLOWED');
    }
    if (row.endpoint !== endpoint || row.payer !== payer.toLowerCase() ||
        row.recipient !== recipient.toLowerCase() || row.amount_units !== gatewayTracePrice ||
        row.network !== network) {
      throw new Error('Request ID already belongs to different payment terms');
    }
    return row;
  };
  const saveDelivery = async (delivery: unknown) => {
    await pool.query('UPDATE gateway_demo_purchases SET delivery = $2 WHERE request_id = $1 AND delivery IS NULL',
      [requestId, JSON.stringify(delivery)]);
  };
  const existing = await findExisting();
  if (existing) {
    const { nonce, delivery } = existing;
    if (delivery !== null && existing.budget_status !== 'reserved') return { status: 'delivered', nonce, delivery };
    const payment = await checkGatewayPayment(pool, requestId, {
      nonce, payer: existing.payer, recipient: existing.recipient,
      amountUnits: existing.amount_units, network: existing.network,
    }, 'buyer', gatewayRequest);
    if (delivery !== null) return { status: 'delivered', nonce, delivery, payment };
    if (payment.status === 'charged' && existing.retrieval_token) {
      let recovered: unknown;
      try {
        const response = await request(endpoint, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { 'trace-retrieval-token': existing.retrieval_token },
        });
        recovered = await receiveDelivery(response, requestId, nonce);
      } catch {
        return { status: 'charged-delivery-missing', nonce, delivery: null, payment };
      }
      await saveDelivery(recovered);
      return { status: 'delivered', nonce, delivery: recovered, payment };
    }
    const status = {
      unknown: 'submission-unknown',
      unavailable: 'submission-unknown',
      pending: 'payment-pending',
      charged: 'charged-delivery-missing',
      failed: 'payment-failed',
      conflict: 'reconciliation-conflict',
    }[payment.status];
    return { status, nonce, delivery: null, payment };
  }

  if (!task) throw new PaymentError(403, 'GATEWAY_TASK_REQUIRED');
  const offer = traceOffer(endpoint, recipient, network);
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
    option.extra.verifyingContract?.toLowerCase() === requirements.extra.verifyingContract.toLowerCase());
  if (quote?.x402Version !== 2 || quote.resource?.url !== endpoint || !matches) {
    throw new Error('Gateway quote differs from the approved terms');
  }

  const authorization: GatewayAuthorization = {
    from: payer, to: recipient, value: requirements.amount, validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + gatewayValidity),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const retrievalToken = randomBytes(32).toString('hex');
  // Only the process that inserts this row may sign and submit. Never replay an ambiguous POST.
  const claimed = await transaction(pool, async (client) => {
    const grant = await lockGatewayGrant(client, task, purchase);
    const claim = await client.query(
      `INSERT INTO gateway_demo_purchases
        (request_id, endpoint, nonce, payer, recipient, amount_units, network, retrieval_token, task_id, budget_day, budget_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved') ON CONFLICT (request_id) DO NOTHING`,
      [requestId, endpoint, authorization.nonce, payer.toLowerCase(), recipient.toLowerCase(),
        requirements.amount, network, retrievalToken, task.taskId, grant.day],
    );
    if (claim.rowCount === 0) return false;
    await checkGatewayBudget(client, task.taskId, grant, requirements.amount);
    await reserveAmount(client, task.taskId, grant.day, requirements.amount);
    return true;
  });
  if (!claimed) {
    const concurrent = await findExisting();
    if (!concurrent) throw new Error('Concurrent signing failed. Retry the same request ID.');
    return {
      status: concurrent.delivery === null ? 'submission-unknown' : 'delivered',
      nonce: concurrent.nonce, delivery: concurrent.delivery,
    };
  }

  const typedData = {
    domain: config.domain, types: gatewayAuthorizationTypes,
    primaryType: 'TransferWithAuthorization', message: authorization,
  } as const;
  let signature: Hex;
  try {
    signature = await sign(typedData);
    const recovered = await recoverGatewayPayer(authorization, signature, network);
    if (recovered.toLowerCase() !== payer.toLowerCase()) throw new Error('Unexpected signing address');
    await transaction(pool, async (client) => {
      await lockGatewayGrant(client, task, purchase);
      const marked = await client.query(
        `UPDATE gateway_demo_purchases SET submitted_at = now()
         WHERE request_id = $1 AND nonce = $2 AND budget_status = 'reserved' AND submitted_at IS NULL`,
        [requestId, authorization.nonce],
      );
      if (marked.rowCount !== 1) throw new Error('Gateway purchase is no longer eligible for submission');
    });
  } catch (error) {
    await transaction(pool, (client) => releaseUnsubmittedGatewayPurchase(client, requestId, authorization.nonce, task.taskId));
    throw error;
  }

  try {
    const response = await request(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {
        'trace-retrieval-token': retrievalToken,
        'payment-signature': encodePaymentHeader({
          x402Version: 2, resource: offer.resource, accepted: requirements,
          payload: { authorization, signature },
        }),
      },
    });
    const delivery = await receiveDelivery(response, requestId, authorization.nonce);
    await saveDelivery(delivery);
    return { status: 'delivered', nonce: authorization.nonce, delivery };
  } catch {
    return { status: 'submission-unknown', nonce: authorization.nonce, delivery: null };
  }
}
