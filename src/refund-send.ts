import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import type { Address, Hash, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { baseSepoliaUsdc, createBaseSettlement } from './base-settlement.js';
import type { Authorization } from './base-settlement.js';
import { getPaymentLedger } from './ledger.js';
import { baseReconciliationChain, reconcilePayments } from './reconciliation.js';
import { baseRefundChain, recordRefund } from './refunds.js';

const { DATABASE_URL, BASE_SEPOLIA_RPC_URL, MERCHANT_TEST_KEY, PAYMENT_RELAYER_KEY } = process.env;
const [intentId, inputReason] = process.argv.slice(2);
const reason = inputReason?.trim();
const isKey = (value: string | undefined): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value ?? '');
if (!DATABASE_URL || !BASE_SEPOLIA_RPC_URL || !isKey(MERCHANT_TEST_KEY) ||
    !isKey(PAYMENT_RELAYER_KEY) || !intentId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(intentId) ||
    !reason || reason.length > 500) {
  throw new Error('Configure the database, Base Sepolia RPC, merchant key and relayer key, then supply an intent ID and refund reason.');
}

class RefundCommandError extends Error {}

const merchant = privateKeyToAccount(MERCHANT_TEST_KEY).address.toLowerCase();
const { rail, getChainId } = createBaseSettlement(BASE_SEPOLIA_RPC_URL, MERCHANT_TEST_KEY, PAYMENT_RELAYER_KEY);
const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
pool.on('error', () => console.error('Idle refund database connection failed'));

try {
  if (await getChainId() !== baseSepolia.id) throw new RefundCommandError('Expected Base Sepolia');
  const [chain, reconciliationChain] = await Promise.all([
    baseRefundChain(BASE_SEPOLIA_RPC_URL), baseReconciliationChain(BASE_SEPOLIA_RPC_URL),
  ]);
  const lock = await pool.connect();
  try {
    const { rows: [lease] } = await lock.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 90251)) AS acquired', [intentId],
    );
    if (!lease?.acquired) throw new RefundCommandError('Another refund command is running for this intent');

    const { rows: [payment] } = await lock.query<{
      payer: Address; payee: string; amount: string; agent_id: string;
      refund_hash: Hash | null; refund_reason: string | null;
    }>(`
      SELECT j.payer, lower(i.payee) AS payee, j.amount, t.agent_id,
        r.transaction_hash AS refund_hash, r.reason AS refund_reason
      FROM payment_journal j
      JOIN payment_intents i ON i.id = j.intent_id
      JOIN research_tasks t ON t.id = i.task_id
      LEFT JOIN payment_refunds r ON r.intent_id = j.intent_id
      WHERE j.intent_id = $1 AND j.network = 'eip155:84532' AND j.asset = $2 AND i.status = 'SETTLED'
    `, [intentId, baseSepoliaUsdc]);
    if (!payment || payment.payee !== merchant) throw new RefundCommandError('Expected a settled payment to this merchant');

    let hash = payment.refund_hash;
    if (hash && payment.refund_reason !== reason) throw new RefundCommandError('Refund already recorded with a different reason');
    if (!hash) {
      const { rows: [saved] } = await lock.query<{
        authorization_payload: Authorization; transaction_hash: Hash | null; reason: string;
      }>('SELECT authorization_payload, transaction_hash, reason FROM refund_authorizations WHERE intent_id = $1', [intentId]);
      if (saved && saved.reason !== reason) throw new RefundCommandError('Resume with the original refund reason');

      if (!saved) {
        const { rowCount } = await lock.query(
          "SELECT 1 FROM refund_requests WHERE intent_id = $1 AND status = 'APPROVED' AND reason = $2", [intentId, reason],
        );
        if (rowCount !== 1) throw new RefundCommandError('Finance approval with the same reason is required before signing');
      }

      const authorization = saved?.authorization_payload ??
        await rail.sign(payment.payer, payment.amount, 300, await rail.head());
      let submitted = saved?.transaction_hash;
      if (!saved) {
        await lock.query(
          'INSERT INTO refund_authorizations (intent_id, authorization_payload, reason) VALUES ($1, $2, $3)',
          [intentId, authorization, reason],
        );
      }

      for (let attempt = 0; attempt < 240; attempt++) {
        const observation = await rail.observe(authorization, submitted ?? undefined);
        if (observation.status === 'settled') {
          hash = observation.hash;
          break;
        }
        if (observation.status === 'expired') {
          throw new RefundCommandError('Refund authorization expired unused. Review it before authorizing a replacement.');
        }
        if (observation.status === 'ready' && !submitted) {
          submitted = await rail.submit(authorization);
          await lock.query('UPDATE refund_authorizations SET transaction_hash = $2 WHERE intent_id = $1',
            [intentId, submitted]);
          console.error('Refund submitted', submitted);
        }
        await setTimeout(10000);
      }
      if (!hash) throw new RefundCommandError('Refund is awaiting finality. Resume with the same intent ID and reason.');

      const receipt = await chain.receipt(hash);
      const transfer = receipt.logs.find((log) => log.from.toLowerCase() === merchant &&
        log.to.toLowerCase() === payment.payer && log.amount === BigInt(payment.amount));
      if (!transfer) throw new RefundCommandError('Matching refund transfer missing from receipt');
      await recordRefund(pool, chain, intentId, hash, transfer.logIndex, reason);
    }

    const receipt = await chain.receipt(hash);
    const [ledger, reconciliation] = await Promise.all([
      getPaymentLedger(pool, payment.agent_id, intentId),
      reconcilePayments(pool, reconciliationChain, payment.payer, receipt.blockNumber, receipt.blockNumber),
    ]);
    const matched = reconciliation.status === 'MATCHED' &&
      reconciliation.matchedRefunds.some((entry) => entry.intentId === intentId && entry.transactionHash === hash);
    console.log(JSON.stringify({ status: matched ? 'PASSED' : 'FAILED',
      refundTransactionUrl: `${baseSepolia.blockExplorers.default.url}/tx/${hash}`, ledger, reconciliation }, null, 2));
    if (!matched) process.exitCode = 2;
  } finally {
    // Closing the connection also releases its session lock after an interrupted run.
    lock.release(true);
  }
} catch (error) {
  if (error instanceof RefundCommandError) console.error(error.message);
  console.error(`Refund command did not complete for ${intentId}. Check the intent, merchant, RPC and refund state before retrying with the same ID and reason.`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
