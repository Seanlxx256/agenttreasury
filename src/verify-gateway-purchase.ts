import { Pool } from 'pg';
import { createPublicClient, http, TransactionReceiptNotFoundError } from 'viem';
import { collectGatewayPurchaseEvidence } from './gateway-purchase-evidence.js';
import { gatewayChainConfig, gatewayRpcUrl, requestIdPattern } from './gateway-x402.js';

const { DATABASE_URL, ARC_TESTNET_RPC_URL = gatewayRpcUrl } = process.env;
const requestId = process.argv[2];
if (!DATABASE_URL || !requestId || !requestIdPattern.test(requestId)) {
  throw new Error('Set DATABASE_URL and pass the original purchase UUID');
}

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
const chain = createPublicClient({ chain: gatewayChainConfig, transport: http(ARC_TESTNET_RPC_URL, { timeout: 5000, retryCount: 0 }) });
try {
  const evidence = await collectGatewayPurchaseEvidence(pool, requestId, async (hash) => {
    if (await chain.getChainId() !== gatewayChainConfig.id) throw new Error('RPC endpoint must serve the selected Arc network');
    try {
      return await chain.getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  });
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.status !== 'PASSED') process.exitCode = evidence.status === 'PENDING' ? 2 : 3;
} finally {
  await pool.end();
}
