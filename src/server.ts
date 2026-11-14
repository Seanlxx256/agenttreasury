import { Pool } from 'pg';
import { merchantConfig } from './merchant.js';
import { buildApp } from './app.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
  statement_timeout: 5000,
  idle_in_transaction_session_timeout: 5000,
});
const app = buildApp(pool, true, process.env.MERCHANT_ENDPOINT ? { merchant: merchantConfig() } : undefined);

pool.on('error', (error) => app.log.error({ err: error }, 'Idle database connection failed'));
app.addHook('onClose', async () => pool.end());

async function stop() {
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, 'Shutdown failed');
    process.exitCode = 1;
  }
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

try {
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
} catch (error) {
  app.log.error({ err: error }, 'Startup failed');
  await stop();
  process.exitCode = 1;
}
