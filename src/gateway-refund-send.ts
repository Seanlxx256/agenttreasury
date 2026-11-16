import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { createWalletClient, erc20Abi, http, TransactionReceiptNotFoundError } from 'viem';
import type { Address, Hash, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcRefundChain, recordGatewayRefund, type GatewayRefundChain } from './gateway-refunds.js';
import { arcTestnetUsdc, gatewayChainConfig, gatewayRpcUrl } from './gateway-x402.js';

export class GatewayRefundCommandError extends Error {}

// Resolves the refund transaction hash without ever broadcasting twice.
//
// The refund transfer is an irreversible external side effect, so the write
// goes through a two-phase handshake against the database: persist a
// "submitting" intent BEFORE broadcasting, then record the hash AFTER a
// successful broadcast. A crash at any point leaves a "submitting" row, and the
// next run refuses to broadcast again — the operator must verify the transfer
// onchain first. Only a row that already carries a hash resumes cleanly.
export async function resolveRefundTransaction(
  client: PoolClient, requestId: string, reason: string, write: () => Promise<Hash>,
): Promise<Hash> {
  const { rows: [saved] } = await client.query<{ transactionHash: Hash | null; reason: string }>(
    'SELECT transaction_hash AS "transactionHash", reason FROM gateway_refund_authorizations WHERE request_id = $1',
    [requestId],
  );
  if (saved && saved.reason !== reason) {
    throw new GatewayRefundCommandError('Resume with the original refund reason');
  }
  if (!saved) {
    const { rowCount } = await client.query(
      "SELECT 1 FROM gateway_refund_requests WHERE request_id = $1 AND status = 'APPROVED' AND reason = $2",
      [requestId, reason],
    );
    if (rowCount !== 1) {
      throw new GatewayRefundCommandError('Finance approval with the same reason is required before refunding');
    }
    // Persist the intent before the broadcast; a retry now sees it and never re-broadcasts.
    await client.query(
      "INSERT INTO gateway_refund_authorizations (request_id, reason, status) VALUES ($1, $2, 'submitting')",
      [requestId, reason],
    );
    let hash: Hash;
    try {
      hash = await write();
    } catch (error) {
      throw new GatewayRefundCommandError(
        'Refund broadcast failed or its result is unknown. Verify the transfer onchain before retrying.');
    }
    await client.query(
      "UPDATE gateway_refund_authorizations SET transaction_hash = $2, status = 'submitted' WHERE request_id = $1",
      [requestId, hash],
    );
    return hash;
  }
  if (!saved.transactionHash) {
    // A previous run persisted the intent but never recorded the hash — the
    // transfer may or may not have gone out, so never broadcast again here.
    throw new GatewayRefundCommandError(
      'Refund submission is unresolved. Verify the transfer onchain before retrying.');
  }
  return saved.transactionHash;
}

async function waitForReceipt(chain: GatewayRefundChain, hash: Hash) {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      return await chain.receipt(hash);
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) {
        await setTimeout(10000);
        continue;
      }
      throw error;
    }
  }
  throw new GatewayRefundCommandError('Refund is awaiting finality. Resume with the same request ID and reason.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { DATABASE_URL, ARC_TESTNET_RPC_URL = gatewayRpcUrl, GATEWAY_MERCHANT_KEY } = process.env;
  const [requestId, inputReason] = process.argv.slice(2);
  const reason = inputReason?.trim();
  const isKey = (value: string | undefined): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value ?? '');
  if (!DATABASE_URL || !isKey(GATEWAY_MERCHANT_KEY) || !requestId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId) ||
      !reason || reason.length > 500) {
    throw new Error('Configure the database, merchant key and RPC, then supply a request ID and refund reason.');
  }

  const account = privateKeyToAccount(GATEWAY_MERCHANT_KEY);
  const merchant = account.address.toLowerCase();
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  pool.on('error', () => console.error('Idle gateway refund database connection failed'));

  try {
    const chain = await arcRefundChain(ARC_TESTNET_RPC_URL);
    const wallet = createWalletClient({
      account, chain: gatewayChainConfig, transport: http(ARC_TESTNET_RPC_URL, { timeout: 5000, retryCount: 1 }),
    });

    const lock = await pool.connect();
    try {
      const { rows: [lease] } = await lock.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 90252)) AS acquired', [requestId],
      );
      if (!lease?.acquired) throw new GatewayRefundCommandError('Another gateway refund command is running for this request');

      const { rows: [payment] } = await lock.query<{
        payer: Address; recipient: string; amount: string;
        refund_hash: Hash | null; refund_reason: string | null;
      }>(`
        SELECT p.payer, p.recipient, j.amount::text AS amount,
          r.transaction_hash AS refund_hash, r.reason AS refund_reason
        FROM gateway_payment_journal j
        JOIN gateway_demo_purchases p ON p.request_id = j.request_id
        LEFT JOIN gateway_payment_refunds r ON r.request_id = j.request_id
        WHERE j.request_id = $1
      `, [requestId]);
      if (!payment || payment.recipient !== merchant) throw new GatewayRefundCommandError('Expected a charged gateway payment to this merchant');

      let hash = payment.refund_hash;
      if (hash && payment.refund_reason !== reason) throw new GatewayRefundCommandError('Refund already recorded with a different reason');
      if (!hash) {
        // A plain USDC transfer back to the payer. The Gateway refund is the
        // inverse of the batched charge, so no EIP-3009 authorization is needed.
        hash = await resolveRefundTransaction(lock, requestId, reason, async () => {
          const txHash = await wallet.writeContract({
            address: arcTestnetUsdc,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [payment.payer, BigInt(payment.amount)],
          });
          console.error('Gateway refund submitted', txHash);
          return txHash;
        });

        const receipt = await waitForReceipt(chain, hash);
        const transfer = receipt.logs.find((log) => log.from.toLowerCase() === merchant &&
          log.to.toLowerCase() === payment.payer && log.amount === BigInt(payment.amount));
        if (!transfer) throw new GatewayRefundCommandError('Matching refund transfer missing from receipt');
        await recordGatewayRefund(pool, chain, requestId, hash, transfer.logIndex, reason);
      }

      const explorer = gatewayChainConfig.blockExplorers?.default?.url;
      console.log(JSON.stringify({ status: 'PASSED',
        refundTransactionUrl: explorer ? `${explorer}/tx/${hash}` : hash,
        requestId, payer: payment.payer, recipient: payment.recipient, amount: payment.amount }, null, 2));
    } finally {
      // Closing the connection also releases its session lock after an interrupted run.
      lock.release(true);
    }
  } catch (error) {
    if (error instanceof GatewayRefundCommandError) console.error(error.message);
    console.error(`Gateway refund command did not complete for ${requestId}. Check the request, merchant, RPC and refund state before retrying with the same ID and reason.`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
