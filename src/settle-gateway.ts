import { randomUUID } from 'node:crypto';
import { recordWorkerHeartbeat } from './gateway-cases.js';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { processGatewayReconciliation } from './gateway-reconciliation-worker.js';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000,
  statement_timeout: 5000, idle_in_transaction_session_timeout: 5000 });
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort());
pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error', worker: 'gateway-reconciliation' })));

try {
  while (!shutdown.signal.aborted) {
    const runId = randomUUID();
    try {
      const processed = await processGatewayReconciliation(pool, fetch, (event) => {
        console.log(JSON.stringify({ runId, ...event }));
      });
      await recordWorkerHeartbeat(pool, 'gateway-reconciliation', true);
      if (processed) continue;
    } catch (error) {
      await recordWorkerHeartbeat(pool, 'gateway-reconciliation', false).catch(() => {});
      console.error(JSON.stringify({ event: 'gateway_recovery_failed', runId, errorType: error instanceof Error ? error.name : 'unknown' }));
    }
    await setTimeout(1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} finally {
  await pool.end();
}
