import { setTimeout } from 'node:timers/promises';

interface ResearchPurchase {
  apiUrl: string;
  token: string;
  taskId: string;
  serviceId: string;
  requestId: string;
}

export async function purchaseResearch(
  purchase: ResearchPurchase, { maxPolls = 60, pollIntervalMs = 5000 } = {},
) {
  const { apiUrl, token, taskId, serviceId, requestId } = purchase;
  async function call(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(new URL(path, apiUrl), {
      ...options, redirect: 'error', signal: AbortSignal.timeout(12000), headers,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`API returned ${response.status}: ${result.code ?? 'unknown error'}`);
    return result;
  }

  let intent = await call('/payment-intents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': requestId },
    body: JSON.stringify({ taskId, serviceId, requestId }),
  });
  const path = `/payment-intents/${intent.id}`;
  for (let poll = 0; ; poll++) {
    if (intent.status === 'SETTLED') {
      const delivery = await call(`${path}/delivery`, { method: 'POST' });
      const ledger = await call(`${path}/ledger`);
      return { delivery, ledger };
    }
    if (intent.status === 'REJECTED' || intent.status === 'FAILED') {
      throw new Error(`Payment ${intent.status}: ${intent.reason}`);
    }
    if (poll >= maxPolls - 1) {
      throw new Error(`Payment is ${intent.status}. Resume with the same purchase UUID: ${requestId}`);
    }
    await setTimeout(pollIntervalMs);
    intent = await call(path);
  }
}
