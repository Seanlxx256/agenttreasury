import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { processGatewayReconciliation } from './gateway-reconciliation-worker.js';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000,
  statement_timeout: 5000, idle_in_transaction_session_timeout: 5000 });
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort());
pool.on('error', () => console.error('Idle Gateway reconciliation database connection failed'));

try {
  while (!shutdown.signal.aborted) {
    try {
      if (await processGatewayReconciliation(pool)) continue;
    } catch (error) {
      console.error('Gateway reconciliation iteration failed', { errorType: error instanceof Error ? error.name : 'unknown' });
    }
    await setTimeout(1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} finally {
  await pool.end();
}
