import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { transaction } from './db.js';

export async function migrate(pool: Pool) {
  const files = ['001_init.sql', '002_quote_worker.sql', '003_settlement.sql', '004_payment_ledger.sql', '005_reconciliation.sql', '006_payment_refunds.sql', '007_merchant_delivery.sql', '008_refund_authorizations.sql', '009_refund_requests.sql', '010_finance_refund_jobs.sql', '011_gateway_demo_purchases.sql', '012_gateway_demo_deliveries.sql', '013_gateway_payment_observations.sql', '014_gateway_task_accounting.sql', '015_gateway_background_reconciliation.sql', '016_gateway_operations_observations.sql', '017_wallet_funding.sql', '018_audit_history.sql', '019_gateway_refunds.sql', '020_gateway_purchase_network.sql', '021_gateway_merchants.sql', '022_gateway_delivery_disputes.sql'];
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(745313)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)');
    for (const [index, file] of files.entries()) {
      const version = index + 1;
      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (rowCount === 0) {
        const sql = await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations VALUES ($1)', [version]);
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
