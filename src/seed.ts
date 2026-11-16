import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { isAddress } from 'viem';
import type { MerchantConfig } from './merchant.js';
import { merchantConfig } from './merchant.js';
import { tokenDigest } from './payments.js';
import { gatewayDemoConfig } from './gateway-x402.js';
import { transaction } from './db.js';

async function createDemoTask(client: PoolClient, budget: number, dailyLimit: number) {
  const token = randomBytes(32).toString('base64url');
  const agentId = randomUUID();
  const taskId = randomUUID();
  await client.query('INSERT INTO agents (id, token_digest) VALUES ($1, $2)', [agentId, tokenDigest(token)]);
  await client.query(
    `INSERT INTO research_tasks (id, agent_id, active_until, budget, daily_limit)
     VALUES ($1, $2, now() + interval '7 days', $3, $4)`, [taskId, agentId, budget, dailyLimit],
  );
  return { token, agentId, taskId };
}

export async function seed(pool: Pool, budget = 3000, dailyLimit = 3000, merchant?: Pick<MerchantConfig, 'endpoint' | 'recipient'>) {
  const serviceId = randomUUID();
  return transaction(pool, async (client) => {
    const task = await createDemoTask(client, budget, dailyLimit);
    await client.query(
      `INSERT INTO services (id, endpoint, network, asset, payee, price)
       VALUES ($1, $2, 'eip155:84532',
         '0x036cbd53842c5426634e7929541ec2318f3dcf7e', $3, 2000)`,
      [serviceId, merchant?.endpoint ?? 'https://merchant.example/market-data',
        merchant?.recipient ?? '0x0000000000000000000000000000000000000001'],
    );
    await client.query('INSERT INTO task_services VALUES ($1, $2)', [task.taskId, serviceId]);
    return { ...task, serviceId };
  });
}

export async function seedGateway(
  pool: Pool, grant: { origin: string; payer: string; recipient: string; network?: 'arc' | 'arcTestnet' },
  budget = 3000, dailyLimit = 3000,
) {
  const network = grant.network ?? 'arcTestnet';
  return transaction(pool, async (client) => {
    const task = await createDemoTask(client, budget, dailyLimit);
    const merchant = await client.query<{ id: string; version: number }>(
      `INSERT INTO gateway_merchants (id, recipient, endpoint_origin, network)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (recipient, network) DO UPDATE SET endpoint_origin = EXCLUDED.endpoint_origin
       RETURNING id, recipient_change_version AS version`,
      [randomUUID(), grant.recipient.toLowerCase(), grant.origin, network],
    );
    const merchantId = merchant.rows[0]!.id;
    await client.query(
      `INSERT INTO gateway_task_grants (task_id, origin, payer, recipient, network, merchant_id, approved_recipient_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [task.taskId, grant.origin, grant.payer.toLowerCase(), grant.recipient.toLowerCase(), network, merchantId, merchant.rows[0]!.version],
    );
    return { ...task, merchantId };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (process.argv[2] === '--gateway') {
      const payer = process.env.GATEWAY_PAYER_ADDRESS;
      if (!payer || !isAddress(payer)) throw new Error('Set GATEWAY_PAYER_ADDRESS');
      const { origin, recipient } = gatewayDemoConfig();
      if (payer.toLowerCase() === recipient.toLowerCase()) throw new Error('Use distinct payer and merchant addresses');
      console.log(JSON.stringify(await seedGateway(pool, { origin, payer, recipient }), null, 2));
    } else {
      console.log(JSON.stringify(await seed(pool, 3000, 3000, process.env.MERCHANT_ENDPOINT ? merchantConfig() : undefined), null, 2));
    }
  } finally {
    await pool.end();
  }
}
