import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import type { MerchantConfig } from './merchant.js';
import { merchantConfig } from './merchant.js';
import { tokenDigest } from './app.js';
import { transaction } from './db.js';

export async function seed(pool: Pool, budget = 3000, dailyLimit = 3000, merchant?: Pick<MerchantConfig, 'endpoint' | 'recipient'>) {
  const token = randomBytes(32).toString('base64url');
  const agentId = randomUUID();
  const taskId = randomUUID();
  const serviceId = randomUUID();
  await transaction(pool, async (client) => {
    await client.query('INSERT INTO agents (id, token_digest) VALUES ($1, $2)', [agentId, tokenDigest(token)]);
    await client.query(
      `INSERT INTO research_tasks (id, agent_id, active_until, budget, daily_limit)
       VALUES ($1, $2, now() + interval '7 days', $3, $4)`, [taskId, agentId, budget, dailyLimit],
    );
    await client.query(
      `INSERT INTO services (id, endpoint, network, asset, payee, price)
       VALUES ($1, $2, 'eip155:84532',
         '0x036cbd53842c5426634e7929541ec2318f3dcf7e', $3, 2000)`,
      [serviceId, merchant?.endpoint ?? 'https://merchant.example/market-data',
        merchant?.recipient ?? '0x0000000000000000000000000000000000000001'],
    );
    await client.query('INSERT INTO task_services VALUES ($1, $2)', [taskId, serviceId]);
  });
  return { token, agentId, taskId, serviceId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log(JSON.stringify(await seed(pool, 3000, 3000, process.env.MERCHANT_ENDPOINT ? merchantConfig() : undefined), null, 2));
  } finally {
    await pool.end();
  }
}
