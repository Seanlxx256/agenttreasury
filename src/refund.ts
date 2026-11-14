import { Pool } from 'pg';
import { baseRefundChain, recordRefund } from './refunds.js';

const { DATABASE_URL, BASE_SEPOLIA_RPC_URL } = process.env;
const [intentId, hash, index, reason] = process.argv.slice(2);
const isHash = (value: string | undefined): value is `0x${string}` => /^0x[0-9a-fA-F]{64}$/.test(value ?? '');
if (!DATABASE_URL || !BASE_SEPOLIA_RPC_URL || !intentId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(intentId) ||
    !isHash(hash) || !index || !/^\d+$/.test(index) || !reason) {
  throw new Error('Set DATABASE_URL and BASE_SEPOLIA_RPC_URL, then run npm run refund -- <intent-id> <transaction-hash> <log-index> <reason>');
}
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
try {
  const chain = await baseRefundChain(BASE_SEPOLIA_RPC_URL);
  console.log(JSON.stringify(await recordRefund(pool, chain, intentId, hash, Number(index), reason), null, 2));
} finally {
  await pool.end();
}
