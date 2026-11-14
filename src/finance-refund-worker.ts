import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { processFinanceRefund, runFinanceRefund } from './finance-refunds.js';

for (const key of ['DATABASE_URL', 'BASE_SEPOLIA_RPC_URL', 'MERCHANT_TEST_KEY', 'PAYMENT_RELAYER_KEY']) {
  if (!process.env[key]) throw new Error(key + ' is required');
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
pool.on('error', () => console.error('Idle finance refund database connection failed'));
const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => stop.abort());

const lock = await pool.connect();
try {
  const { rows: [row] } = await lock.query('SELECT pg_try_advisory_lock(742012) AS acquired');
  if (!row?.acquired) throw new Error('A finance refund worker is already running for this database');
  // A previous worker may have stopped mid-run. The CLI retains its per-intent lock and signed authorization.
  await lock.query(`
    UPDATE finance_refund_jobs SET lease_token = NULL, available_at = now()
    WHERE finished_at IS NULL AND lease_token IS NOT NULL
  `);
  lock.on('error', () => stop.abort());
  while (!stop.signal.aborted) {
    try {
      if (await processFinanceRefund(pool, (id, reason) => runFinanceRefund(id, reason, stop.signal))) continue;
    } catch {
      console.error('Finance refund worker iteration failed');
    }
    await setTimeout(1000, undefined, { signal: stop.signal }).catch(() => {});
  }
} finally {
  lock.release(true);
  await pool.end();
}
