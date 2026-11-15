import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { getTypesForEIP712Domain, isAddress, type Hex } from 'viem';
import { purchaseGatewayTrace } from './gateway-purchase.js';
import { gatewayDemoConfig, requestIdPattern } from './gateway-x402.js';

const run = promisify(execFile);
const { DATABASE_URL, GATEWAY_PAYER_ADDRESS } = process.env;
const [requestId] = process.argv.slice(2);
if (!DATABASE_URL || !GATEWAY_PAYER_ADDRESS || !isAddress(GATEWAY_PAYER_ADDRESS) ||
    !requestId || !requestIdPattern.test(requestId)) {
  throw new Error('Set DATABASE_URL and GATEWAY_PAYER_ADDRESS, then pass a lowercase request UUID');
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
  }, async (typedData) => {
    const data = JSON.stringify({
      ...typedData,
      types: { EIP712Domain: getTypesForEIP712Domain({ domain: typedData.domain }), ...typedData.types },
    });
    let stdout: string;
    try {
      ({ stdout } = await run('circle', [
        'wallet', 'sign', 'typed-data', data,
        '--address', payer, '--chain', 'ARC-TESTNET', '--output', 'json',
      ], { timeout: 30000 }));
    } catch {
      throw new Error('Circle signing failed. Check that Circle CLI is installed and the Arc testnet wallet is authenticated.');
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
