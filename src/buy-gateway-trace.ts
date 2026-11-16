import { Pool } from 'pg';
import { isAddress } from 'viem';
import { gatewaySignerClient } from './gateway-signer-client.js';
import { purchaseGatewayTrace } from './gateway-purchase.js';
import { arcTestnetClient, gatewayChainConfig, gatewayDemoConfig, requestIdPattern } from './gateway-x402.js';

const { DATABASE_URL, GATEWAY_PAYER_ADDRESS, GATEWAY_TASK_ID, AGENT_TOKEN } = process.env;
const [requestId] = process.argv.slice(2);
if (!DATABASE_URL || !GATEWAY_PAYER_ADDRESS || !isAddress(GATEWAY_PAYER_ADDRESS) ||
    !requestId || !requestIdPattern.test(requestId)) {
  throw new Error('Set DATABASE_URL and GATEWAY_PAYER_ADDRESS, then pass a lowercase request UUID');
}
if ((GATEWAY_TASK_ID || AGENT_TOKEN) &&
    (!GATEWAY_TASK_ID || !requestIdPattern.test(GATEWAY_TASK_ID) || !AGENT_TOKEN || !/^[A-Za-z0-9_-]{43}$/.test(AGENT_TOKEN))) {
  throw new Error('Set GATEWAY_TASK_ID and AGENT_TOKEN from the Gateway task seed');
}

const { recipient, origin } = gatewayDemoConfig();
if (recipient.toLowerCase() === GATEWAY_PAYER_ADDRESS.toLowerCase()) {
  throw new Error('Use distinct payer and merchant addresses');
}
const payer = GATEWAY_PAYER_ADDRESS;
if (process.env.GATEWAY_TESTNET_SIGNER_FILE || process.env.GATEWAY_SIGNER_KEY_FILE) {
  throw new Error('The buyer must not receive a signing key path. Configure the separate Gateway signer service.');
}
const { GATEWAY_SIGNER_URL, GATEWAY_SIGNER_TOKEN } = process.env;
if (!GATEWAY_SIGNER_URL || !GATEWAY_SIGNER_TOKEN || !GATEWAY_TASK_ID || !AGENT_TOKEN) {
  throw new Error('Set GATEWAY_SIGNER_URL, GATEWAY_SIGNER_TOKEN, GATEWAY_TASK_ID and AGENT_TOKEN');
}
const remoteSign = gatewaySignerClient(GATEWAY_SIGNER_URL, GATEWAY_SIGNER_TOKEN, requestId,
  { taskId:GATEWAY_TASK_ID,agentToken:AGENT_TOKEN });
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
try {
  const result = await purchaseGatewayTrace(pool, {
    requestId, payer, recipient, endpoint: `${origin}/trace/${requestId}`,
    task: GATEWAY_TASK_ID && AGENT_TOKEN ? { taskId: GATEWAY_TASK_ID, agentToken: AGENT_TOKEN } : undefined,
  }, async (typedData) => {
    const chain = arcTestnetClient();
    if (await chain.getChainId() !== gatewayChainConfig.id) throw new Error('RPC endpoint must serve the selected Arc network');
    const code = await chain.getCode({ address: payer });
    if (code && code !== '0x') throw new Error('Gateway batch payments require an Arc EOA as payer.');
    return remoteSign(typedData);
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'delivered') process.exitCode = 2;
} finally {
  await pool.end();
}
