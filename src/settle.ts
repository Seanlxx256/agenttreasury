import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { createBaseSettlement } from './base-settlement.js';
import { processSettlement } from './settlement-worker.js';

const { DATABASE_URL, BASE_SEPOLIA_RPC_URL, PAYMENT_PAYER_KEY, PAYMENT_RELAYER_KEY } = process.env;
const isKey = (value: string | undefined): value is `0x${string}` => /^0x[0-9a-fA-F]{64}$/.test(value ?? '');
if (!DATABASE_URL || !BASE_SEPOLIA_RPC_URL || !isKey(PAYMENT_PAYER_KEY) || !isKey(PAYMENT_RELAYER_KEY)) {
  throw new Error('DATABASE_URL, BASE_SEPOLIA_RPC_URL, PAYMENT_PAYER_KEY and PAYMENT_RELAYER_KEY are required');
}
const { rail, getChainId } = createBaseSettlement(BASE_SEPOLIA_RPC_URL, PAYMENT_PAYER_KEY, PAYMENT_RELAYER_KEY);
if (await getChainId() !== 84532) throw new Error('RPC endpoint must serve Base Sepolia');

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000,
  statement_timeout: 5000, idle_in_transaction_session_timeout: 5000 });
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort());
pool.on('error', () => console.error('Idle settlement database connection failed'));

try {
  while (!shutdown.signal.aborted) {
    try {
      if (await processSettlement(pool, rail)) continue;
    } catch (error) {
      console.error('Settlement worker iteration failed', { errorType: error instanceof Error ? error.name : 'unknown' });
    }
    await setTimeout(1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} finally {
  await pool.end();
}
