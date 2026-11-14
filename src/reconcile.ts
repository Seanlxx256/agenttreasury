import { Pool } from 'pg';
import { isAddress } from 'viem';
import { baseReconciliationChain, reconcilePayments } from './reconciliation.js';

const { DATABASE_URL, BASE_SEPOLIA_RPC_URL } = process.env;
const [payer, from, to] = process.argv.slice(2);
if (!DATABASE_URL || !BASE_SEPOLIA_RPC_URL || !payer || !isAddress(payer) ||
    !from || !to || !/^[0-9]+$/.test(from) || !/^[0-9]+$/.test(to)) {
  throw new Error('Set DATABASE_URL and BASE_SEPOLIA_RPC_URL, then run npm run reconcile -- <payer> <from-block> <to-block>');
}

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
try {
  const chain = await baseReconciliationChain(BASE_SEPOLIA_RPC_URL);
  const report = await reconcilePayments(pool, chain, payer, BigInt(from), BigInt(to));
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'DISCREPANCY') process.exitCode = 2;
} finally {
  await pool.end();
}
