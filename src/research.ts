import { purchaseResearch } from './research-client.js';

const { AGENT_TOKEN, TASK_ID, SERVICE_ID, API_URL = 'http://127.0.0.1:3000' } = process.env;
const [requestId] = process.argv.slice(2);
if (!AGENT_TOKEN || !TASK_ID || !SERVICE_ID || !requestId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) {
  throw new Error('Set AGENT_TOKEN, TASK_ID and SERVICE_ID, then supply a stable purchase UUID');
}

const result = await purchaseResearch({ apiUrl: API_URL, token: AGENT_TOKEN, taskId: TASK_ID,
  serviceId: SERVICE_ID, requestId });
console.log(JSON.stringify(result, null, 2));
