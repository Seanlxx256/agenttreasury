import { Pool } from 'pg';
import { buildGatewayMerchant } from './gateway-merchant.js';
import { gatewayDemoConfig } from './gateway-x402.js';

const { origin, port, recipient } = gatewayDemoConfig();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
const app = buildGatewayMerchant(pool, origin, recipient);
app.addHook('onClose', () => pool.end());
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close(); });
try {
  const address = await app.listen({ host: '127.0.0.1', port });
  console.log(`Arc testnet trace merchant listening at ${address}`);
} catch (error) {
  await app.close();
  throw error;
}
