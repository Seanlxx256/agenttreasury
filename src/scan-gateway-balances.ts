import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { isAddress } from 'viem';
import { gatewayBalanceChain } from './gateway-balance-chain.js';
import { runGatewayBalanceScan } from './gateway-balance-scanner.js';
import { recordWorkerHeartbeat } from './gateway-cases.js';

const { DATABASE_URL, GATEWAY_SCAN_PAYER } = process.env;
if (!DATABASE_URL || !GATEWAY_SCAN_PAYER || !isAddress(GATEWAY_SCAN_PAYER)) {
  throw new Error('DATABASE_URL and a valid GATEWAY_SCAN_PAYER are required');
}
if (process.env.GATEWAY_NETWORK && process.env.GATEWAY_NETWORK !== 'arcTestnet') {
  throw new Error('The operations deployment supports arcTestnet only');
}
const interval = Number(process.env.GATEWAY_SCAN_INTERVAL_MS ?? 30_000);
if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 60_000) throw new Error('Invalid scan interval');
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown.abort());
pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error', worker: 'balance-scanner' })));
try {
  while (!shutdown.signal.aborted) {
    const runId = randomUUID();
    const start = Date.now();
    try {
      const outcome = await runGatewayBalanceScan(pool, await gatewayBalanceChain('arcTestnet'), GATEWAY_SCAN_PAYER);
      await recordWorkerHeartbeat(pool, 'balance-scanner', true);
      console.log(JSON.stringify({ event: 'balance_scan_completed', runId, durationMs: Date.now()-start, ...outcome }));
    } catch (error) {
      await recordWorkerHeartbeat(pool, 'balance-scanner', false).catch(() => {});
      console.error(JSON.stringify({ event: 'balance_scan_failed', runId, durationMs: Date.now()-start,
        errorType: error instanceof Error ? error.name : 'unknown' }));
    }
    await setTimeout(interval, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} finally { await pool.end(); }
