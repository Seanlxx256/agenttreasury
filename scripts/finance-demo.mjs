import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { baseSepoliaUsdc } from '../dist/src/base-settlement.js';
import { transaction } from '../dist/src/db.js';
import { postSettledPayment } from '../dist/src/ledger.js';
import { requestRefund } from '../dist/src/refund-requests.js';

const home = new URL('../.finance-local/', import.meta.url);
const { password } = JSON.parse(readFileSync(new URL('credentials.json', home), 'utf8'));
const port = Number(readFileSync(new URL('db/postmaster.pid', home), 'utf8').split('\n')[3]);
const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', password,
  connectionTimeoutMillis: 3000, statement_timeout: 5000 });
const network = 'demo:local';
const payer = '0x0000000000000000000000000000000000000001';
const payee = '0x0000000000000000000000000000000000000002';
const hash = () => '0x' + randomBytes(32).toString('hex');

try {
  const { intentId, agentId } = await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(741920)');
    const { rows: [pending] } = await client.query(`
      SELECT i.id, t.agent_id FROM payment_intents i
      JOIN research_tasks t ON t.id = i.task_id
      LEFT JOIN refund_requests q ON q.intent_id = i.id
      WHERE i.network = $1 AND (q.status = 'PENDING' OR q.status IS NULL) LIMIT 1
    `, [network]);
    if (pending) return { intentId: pending.id, agentId: pending.agent_id };

    const agentId = randomUUID();
    const taskId = randomUUID();
    const serviceId = randomUUID();
    const intentId = randomUUID();
    const paymentHash = hash();
    await client.query('INSERT INTO agents (id, token_digest, enabled) VALUES ($1, $2, false)',
      [agentId, randomBytes(32)]);
    await client.query(`
      INSERT INTO research_tasks (id, agent_id, active_until, enabled, budget, daily_limit, spent)
      VALUES ($1, $2, now(), false, 3000, 3000, 2000)
    `, [taskId, agentId]);
    await client.query(`
      INSERT INTO services (id, endpoint, network, asset, payee, price, enabled)
      VALUES ($1, 'https://merchant.example/market-data', 'eip155:84532', $2, $3, 2000, false)
    `, [serviceId, baseSepoliaUsdc, payee]);
    await client.query(`
      INSERT INTO payment_intents (id, task_id, service_id, request_id, idempotency_key, status,
        policy_version, endpoint, network, asset, payee, amount, budget_day, quote,
        signed_authorization, transaction_hash, settled_at)
      VALUES ($1, $2, $3, $1, $1::uuid::text, 'SETTLED', 'demo', 'https://merchant.example/market-data',
        $4, $5, $6, 2000, (now() AT TIME ZONE 'UTC')::date, '{"demo":true}', $7, $8, now())
    `, [intentId, taskId, serviceId, network, baseSepoliaUsdc, payee, { from: payer, nonce: hash() }, paymentHash]);
    await postSettledPayment(client, intentId);
    return { intentId, agentId };
  });
  await requestRefund(pool, intentId, agentId, 'Local demo: the requested research data was unavailable.');
  console.log('Pending demo refund:', intentId);
} finally {
  await pool.end();
}
