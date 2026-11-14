import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { processQuote } from './quote-worker.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000,
  statement_timeout: 5000, idle_in_transaction_session_timeout: 5000 });
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort());
pool.on('error', (error) => console.error('Idle database connection failed', error));

try {
  while (!shutdown.signal.aborted) {
    try {
      if (await processQuote(pool)) continue;
    } catch (error) {
      console.error('Quote worker failed', error);
    }
    await setTimeout(1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} finally {
  await pool.end();
}
