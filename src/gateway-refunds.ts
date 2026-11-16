import type { Pool, PoolClient } from 'pg';
import { createPublicClient, decodeEventLog, http, parseAbi } from 'viem';
import type { Hash } from 'viem';
import { lockIncomingTransfer, transaction } from './db.js';
import { PaymentError } from './payments.js';
import { arcGatewayNetwork, arcTestnetUsdc, gatewayChainConfig, gatewayRpcUrl } from './gateway-x402.js';

interface Receipt {
  blockNumber: bigint;
  blockHash: Hash;
  transactionIndex: number;
  status: 'success' | 'reverted';
  logs: { address: string; logIndex: number; from: string; to: string; amount: bigint }[];
}

export interface GatewayRefundChain {
  finalized(): Promise<bigint>;
  blockHash(block: bigint): Promise<Hash>;
  receipt(hash: Hash): Promise<Receipt>;
}

const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

// Arc-side counterpart to baseRefundChain: reads USDC Transfer logs so a refund
// can be proven onchain with the same evidence rules the Base rail uses.
export async function arcRefundChain(rpc?: string): Promise<GatewayRefundChain> {
  const url = rpc ?? gatewayRpcUrl;
  if (!url) throw new Error('Arc RPC URL is required');
  const client = createPublicClient({ chain: gatewayChainConfig, transport: http(url, { timeout: 5000, retryCount: 1 }) });
  if (await client.getChainId() !== gatewayChainConfig.id) throw new Error('RPC endpoint must serve the selected Arc network');
  return {
    async finalized() {
      return (await client.getBlock({ blockTag: 'finalized' })).number;
    },
    async blockHash(blockNumber) {
      return (await client.getBlock({ blockNumber })).hash;
    },
    async receipt(hash) {
      const receipt = await client.getTransactionReceipt({ hash });
      const logs: Receipt['logs'] = [];
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== arcTestnetUsdc.toLowerCase()) continue;
        try {
          const { args } = decodeEventLog({ abi: transferAbi, eventName: 'Transfer', ...log });
          logs.push({ address: log.address, logIndex: log.logIndex, from: args.from, to: args.to, amount: args.value });
        } catch {
          // Other USDC events are irrelevant to the refund.
        }
      }
      return { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
        transactionIndex: receipt.transactionIndex, status: receipt.status, logs };
    },
  };
}

export interface GatewayPayment {
  payer: string;
  recipient: string;
  batchHash: Hash;
  amount: string;
}

export interface GatewayRefund {
  requestId: string;
  transactionHash: Hash;
  logIndex: number;
  blockNumber: string;
  reason: string;
  postedAt: Date;
}

const refundFields = `request_id AS "requestId", transaction_hash AS "transactionHash",
  log_index AS "logIndex", block_number AS "blockNumber", reason, posted_at AS "postedAt"`;

const readRefund = `SELECT ${refundFields} FROM gateway_payment_refunds WHERE request_id = $1`;

function replayRefund(previous: GatewayRefund, hash: Hash, logIndex: number, reason: string) {
  if (previous.transactionHash !== hash || previous.logIndex !== logIndex || previous.reason !== reason) {
    throw new PaymentError(409, 'REFUND_ALREADY_RECORDED');
  }
  return previous;
}

// Verify that `hash` proves a refund of `payment` without writing anything.
//
// A Gateway refund is the inverse of the batched charge: the seller moves the
// same USDC amount back to the buyer's payer address in a later transaction. It
// must post after the original batch, carry a matching USDC Transfer from
// recipient to payer, be finalized, and survive a reorg check. Recovery uses
// this BEFORE it commits any state, so a wrong hash cannot leave a stuck row.
export async function verifyGatewayRefundEvidence(
  chain: GatewayRefundChain, hash: Hash, logIndex: number, payment: GatewayPayment,
): Promise<{ blockNumber: string; blockHash: Hash }> {
  if (hash === payment.batchHash) throw new PaymentError(422, 'INVALID_REFUND_EVIDENCE');

  const [refundReceipt, original, finalized] = await Promise.all([
    chain.receipt(hash), chain.receipt(payment.batchHash), chain.finalized(),
  ]);
  if (refundReceipt.blockNumber > finalized) throw new PaymentError(409, 'REFUND_NOT_FINALIZED');
  const transfer = refundReceipt.logs.find((log) => log.logIndex === logIndex);
  if (refundReceipt.status !== 'success' || original.status !== 'success' ||
      refundReceipt.blockNumber < original.blockNumber ||
      (refundReceipt.blockNumber === original.blockNumber && refundReceipt.transactionIndex <= original.transactionIndex) ||
      !transfer || transfer.address.toLowerCase() !== arcTestnetUsdc.toLowerCase() ||
      transfer.from.toLowerCase() !== payment.recipient.toLowerCase() ||
      transfer.to.toLowerCase() !== payment.payer.toLowerCase() ||
      transfer.amount !== BigInt(payment.amount)) {
    throw new PaymentError(422, 'INVALID_REFUND_EVIDENCE');
  }
  const [refundBlock, originalBlock] = await Promise.all([
    chain.blockHash(refundReceipt.blockNumber), chain.blockHash(original.blockNumber),
  ]);
  if (refundBlock !== refundReceipt.blockHash || originalBlock !== original.blockHash) {
    throw new PaymentError(422, 'INVALID_REFUND_EVIDENCE');
  }
  return { blockNumber: String(refundReceipt.blockNumber), blockHash: refundBlock };
}

// Post a verified refund inside the caller's transaction: take the journal row
// lock, replay an identical existing refund, reject a reused transfer, insert the
// refund evidence, and close any dispute that approved this return.
export async function insertGatewayRefund(
  client: PoolClient, requestId: string, hash: Hash, logIndex: number,
  blockNumber: string, blockHash: Hash, reason: string,
): Promise<GatewayRefund> {
  await client.query('SELECT request_id FROM gateway_payment_journal WHERE request_id = $1 FOR UPDATE', [requestId]);
  const { rows: [previous] } = await client.query<GatewayRefund>(readRefund, [requestId]);
  if (previous) return replayRefund(previous, hash, logIndex, reason);
  await lockIncomingTransfer(client, arcGatewayNetwork, hash, logIndex);
  const funding = await client.query(`SELECT 1 FROM wallet_funding
    WHERE network = $1 AND transaction_hash = $2 AND log_index = $3`, [arcGatewayNetwork, hash, logIndex]);
  if (funding.rowCount) throw new PaymentError(409, 'REFUND_TRANSFER_ALREADY_USED');

  const { rows: [inserted] } = await client.query<GatewayRefund>(`
    INSERT INTO gateway_payment_refunds (request_id, network, transaction_hash, log_index, block_number, block_hash, reason)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (network, transaction_hash, log_index) DO NOTHING
    RETURNING ${refundFields}
  `, [requestId, arcGatewayNetwork, hash, logIndex, blockNumber, blockHash, reason]);
  if (!inserted) throw new PaymentError(409, 'REFUND_TRANSFER_ALREADY_USED');
  // The refund is now proven onchain, which finishes any dispute that approved
  // this return. A plain refund request has no dispute row, so this is a no-op
  // there.
  await client.query(
    "UPDATE gateway_delivery_disputes SET status = 'REFUNDED' WHERE request_id = $1 AND status = 'REFUND_APPROVED'",
    [requestId],
  );
  return inserted;
}

export async function recordGatewayRefund(
  pool: Pool, chain: GatewayRefundChain, requestId: string, transactionHash: Hash, logIndex: number, note: string,
) {
  const reason = note.trim();
  const hash = transactionHash.toLowerCase() as Hash;
  if (!/^0x[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(logIndex) ||
      logIndex < 0 || logIndex > 2147483647 || !reason || reason.length > 500) {
    throw new PaymentError(400, 'INVALID_REFUND_REQUEST');
  }

  const { rows: [existing] } = await pool.query<GatewayRefund>(readRefund, [requestId]);
  if (existing) return replayRefund(existing, hash, logIndex, reason);
  const { rows: [payment] } = await pool.query<GatewayPayment>(`
    SELECT p.payer, p.recipient, j.batch_hash AS "batchHash", j.amount::text AS amount
    FROM gateway_payment_journal j JOIN gateway_demo_purchases p ON p.request_id = j.request_id
    WHERE j.request_id = $1
  `, [requestId]);
  if (!payment) throw new PaymentError(409, 'CHARGED_PAYMENT_REQUIRED');

  const evidence = await verifyGatewayRefundEvidence(chain, hash, logIndex, payment);
  return transaction(pool, async (client) =>
    insertGatewayRefund(client, requestId, hash, logIndex, evidence.blockNumber, evidence.blockHash, reason));
}
