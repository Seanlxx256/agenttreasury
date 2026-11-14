import { setTimeout } from 'node:timers/promises';

const { AGENT_TOKEN, TASK_ID, SERVICE_ID, API_URL = 'http://127.0.0.1:3000' } = process.env;
const [requestId] = process.argv.slice(2);
if (!AGENT_TOKEN || !TASK_ID || !SERVICE_ID || !requestId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) {
  throw new Error('Set AGENT_TOKEN, TASK_ID and SERVICE_ID, then supply a stable purchase UUID');
}
const headers = { authorization: `Bearer ${AGENT_TOKEN}` };
async function call(path: string, options: RequestInit = {}) {
  const response = await fetch(new URL(path, API_URL), {
    ...options, redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { ...headers, ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`API returned ${response.status}: ${result.code ?? 'unknown error'}`);
  return result;
}

let intent = await call('/payment-intents', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': requestId },
  body: JSON.stringify({ taskId: TASK_ID, serviceId: SERVICE_ID, requestId }),
});
const path = `/payment-intents/${intent.id}`;
for (let poll = 0; poll < 60; poll++) {
  if (intent.status === 'SETTLED') {
    const delivery = await call(`${path}/delivery`, { method: 'POST' });
    const ledger = await call(`${path}/ledger`);
    console.log(JSON.stringify({ delivery, ledger }, null, 2));
    break;
  }
  if (intent.status === 'REJECTED' || intent.status === 'FAILED') {
    throw new Error(`Payment ${intent.status}: ${intent.reason}`);
  }
  if (poll === 59) throw new Error(`Payment is ${intent.status}. Resume with the same purchase UUID: ${requestId}`);
  await setTimeout(5000);
  intent = await call(path);
}
