import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { getTypesForEIP712Domain, isAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { purchaseGatewayTrace } from './gateway-purchase.js';
import { arcTestnetClient, gatewayChainConfig, gatewayCircleChain, gatewayDemoConfig, requestIdPattern } from './gateway-x402.js';

const run = promisify(execFile);
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
    if (process.env.GATEWAY_TESTNET_SIGNER_FILE) {
      const key = (await readFile(process.env.GATEWAY_TESTNET_SIGNER_FILE, 'utf8')).trim();
      if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error('Invalid Arc signing key file');
      const account = privateKeyToAccount(key as Hex);
      if (account.address.toLowerCase() !== payer.toLowerCase()) throw new Error('Signing key does not match payer');
      const { message } = typedData;
      return account.signTypedData({ ...typedData, message: {
        ...message, value: BigInt(message.value), validAfter: BigInt(message.validAfter),
        validBefore: BigInt(message.validBefore),
      } });
    }
    const data = JSON.stringify({
      ...typedData,
      types: { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }), ...typedData.types },
    });
    let stdout: string;
    try {
      ({ stdout } = await run('circle', [
        'wallet', 'sign', 'typed-data', data,
        '--address', payer, '--chain', gatewayCircleChain, '--output', 'json',
      ], { timeout: 30000 }));
    } catch {
      throw new Error('Circle signing failed. Check that Circle CLI can sign from the configured Arc EOA.');
    }
    const output = JSON.parse(stdout);
    const signature = output?.data?.signature ?? output?.signature;
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
      throw new Error('Circle CLI did not return a valid signature');
    }
    return signature as Hex;
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'delivered') process.exitCode = 2;
} finally {
  await pool.end();
}
