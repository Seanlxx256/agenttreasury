import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from './db.js';

export interface Purchase {
  taskId: string;
  serviceId: string;
  requestId: string;
}

interface Intent {
  id: string;
  status: 'RESERVED' | 'QUOTED' | 'REJECTED' | 'FAILED' | 'AUTHORIZED' | 'SUBMITTED' | 'UNKNOWN' | 'SETTLED';
  transactionHash: string | null;
  reason: string | null;
  amount: string;
  network: string;
  asset: string;
  payee: string;
  serviceId: string;
  requestId: string;
  policyVersion: string;
}

const intentColumns = `id, status, reason, amount, network, asset, payee, transaction_hash AS "transactionHash",
  service_id AS "serviceId", request_id AS "requestId", policy_version AS "policyVersion"`;

export class PaymentError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
  }
}

export async function createIntent(pool: Pool, agentId: string, key: string, purchase: Purchase) {
  const { taskId, serviceId, requestId } = purchase;
  return transaction(pool, async (client) => {
    // Serialize reservations and idempotency checks for this task across API instances.
    const { rows: [task] } = await client.query<{
      enabled: boolean; budget: string; daily_limit: string; reserved: string; spent: string;
    }>(`SELECT enabled, budget, daily_limit, reserved, spent
         FROM research_tasks WHERE id = $1 AND agent_id = $2 FOR UPDATE`, [taskId, agentId]);
    if (!task) throw new PaymentError(404, 'TASK_NOT_FOUND');

    const { rows: [agent] } = await client.query<{ enabled: boolean }>(
      'SELECT enabled FROM agents WHERE id = $1 FOR SHARE', [agentId],
    );
    if (!agent?.enabled) throw new PaymentError(401, 'UNAUTHORIZED');

    const { rows: [existing] } = await client.query<Intent>(
      `SELECT ${intentColumns} FROM payment_intents WHERE task_id = $1 AND idempotency_key = $2`,
      [taskId, key],
    );
    if (existing) {
      if (existing.serviceId !== serviceId || existing.requestId !== requestId) {
        throw new PaymentError(409, 'IDEMPOTENCY_CONFLICT');
      }
      return { intent: existing, created: false };
    }

    const { rowCount: duplicate } = await client.query(
      'SELECT 1 FROM payment_intents WHERE task_id = $1 AND request_id = $2', [taskId, requestId],
    );
    if (duplicate) throw new PaymentError(409, 'PURCHASE_ALREADY_EXISTS');

    const { rows: [service] } = await client.query<{
      price: string; endpoint: string; network: string; asset: string; payee: string;
    }>(`SELECT s.price, s.endpoint, s.network, s.asset, s.payee
         FROM services s JOIN task_services g ON g.service_id = s.id
         WHERE g.task_id = $1 AND s.id = $2 AND s.enabled
         FOR SHARE OF s, g`, [taskId, serviceId]);
    if (!service) throw new PaymentError(403, 'SERVICE_NOT_ALLOWED');

    const { rows: [clock] } = await client.query<{ active: boolean; day: string }>(
      `SELECT active_until > statement_timestamp() AS active,
         (statement_timestamp() AT TIME ZONE 'UTC')::date::text AS day
       FROM research_tasks WHERE id = $1`, [taskId],
    );
    if (!clock) throw new Error('Locked task disappeared');
    if (!task.enabled || !clock.active) throw new PaymentError(403, 'TASK_DISABLED_OR_EXPIRED');

    const { rows: [daily] } = await client.query<{ reserved: string; spent: string }>(
      'SELECT reserved, spent FROM daily_spend WHERE task_id = $1 AND day = $2',
      [taskId, clock.day],
    );
    const price = BigInt(service.price);
    const total = BigInt(task.reserved) + BigInt(task.spent) + price;
    const dailyTotal = BigInt(daily?.reserved ?? '0') + BigInt(daily?.spent ?? '0') + price;

    let reason = null;
    if (total > BigInt(task.budget)) reason = 'TASK_BUDGET_EXCEEDED';
    else if (dailyTotal > BigInt(task.daily_limit)) reason = 'DAILY_LIMIT_EXCEEDED';

    const { rows: [intent] } = await client.query<Intent>(
      `INSERT INTO payment_intents
         (id, task_id, service_id, request_id, idempotency_key, status, reason, policy_version,
          endpoint, network, asset, payee, amount, budget_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1', $8, $9, $10, $11, $12, $13)
       RETURNING ${intentColumns}`,
      [randomUUID(), taskId, serviceId, requestId, key, reason ? 'REJECTED' : 'RESERVED', reason,
        service.endpoint, service.network, service.asset, service.payee, service.price, clock.day],
    );
    if (!intent) throw new Error('Payment intent was not persisted');

    if (intent.status === 'RESERVED') {
      await client.query('UPDATE research_tasks SET reserved = reserved + $2 WHERE id = $1', [taskId, service.price]);
      await client.query(
        `INSERT INTO daily_spend (task_id, day, reserved) VALUES ($1, $2, $3)
         ON CONFLICT (task_id, day) DO UPDATE SET reserved = daily_spend.reserved + EXCLUDED.reserved`,
        [taskId, clock.day, service.price],
      );
      await client.query("INSERT INTO outbox (intent_id, event_type) VALUES ($1, 'payment.reserved')", [intent.id]);
    }
    return { intent, created: true };
  });
}

export async function getIntent(pool: Pool, agentId: string, id: string) {
  const { rows: [intent] } = await pool.query<Intent>(
    `SELECT ${intentColumns} FROM payment_intents
     WHERE id = $1 AND task_id IN (SELECT id FROM research_tasks WHERE agent_id = $2)`, [id, agentId],
  );
  if (!intent) throw new PaymentError(404, 'INTENT_NOT_FOUND');
  return intent;
}
