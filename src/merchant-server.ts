import { Pool } from 'pg';
import { buildMerchant, merchantConfig } from './merchant.js';
import { baseRefundChain } from './refunds.js';

const { DATABASE_URL, BASE_SEPOLIA_RPC_URL } = process.env;
if (!DATABASE_URL || !BASE_SEPOLIA_RPC_URL) throw new Error('DATABASE_URL and BASE_SEPOLIA_RPC_URL are required');
const config = merchantConfig();
const chain = await baseRefundChain(BASE_SEPOLIA_RPC_URL);
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
const app = buildMerchant(pool, config, chain);
app.addHook('onClose', async () => pool.end());
pool.on('error', () => console.error('Idle merchant database connection failed'));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close(); });
try {
  const address = await app.listen({ host: '127.0.0.1', port: Number(process.env.MERCHANT_PORT ?? 3001) });
  console.log(`Merchant listening at ${address}`);
} catch (error) {
  await app.close();
  throw error;
}
