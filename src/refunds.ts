import type { Pool } from 'pg';
import { createPublicClient, decodeEventLog, http, parseAbi } from 'viem';
import type { Hash } from 'viem';
import { baseSepolia } from 'viem/chains';
import { baseSepoliaUsdc } from './base-settlement.js';
import { lockIncomingTransfer, transaction } from './db.js';
import { PaymentError } from './payments.js';

interface Receipt {
  blockNumber: bigint;
  blockHash: Hash;
  transactionIndex: number;
  status: 'success' | 'reverted';
  logs: { address: string; logIndex: number; from: string; to: string; amount: bigint }[];
}

export interface RefundChain {
  finalized(): Promise<bigint>;
  blockHash(block: bigint): Promise<Hash>;
  receipt(hash: Hash): Promise<Receipt>;
}

const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

export async function baseRefundChain(rpc: string): Promise<RefundChain> {
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpc, { timeout: 5000, retryCount: 1 }) });
  if (await client.getChainId() !== baseSepolia.id) throw new Error('RPC endpoint must serve Base Sepolia');
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
        if (log.address.toLowerCase() !== baseSepoliaUsdc) continue;
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

interface Payment {
  network: string;
  asset: string;
  payer: string;
  payee: string;
  original_hash: Hash;
  amount: string;
}

interface Refund {
  intentId: string;
  transactionHash: Hash;
  logIndex: number;
  blockNumber: string;
  reason: string;
  postedAt: Date;
}

const fields = `intent_id AS "intentId", transaction_hash AS "transactionHash",
  log_index AS "logIndex", block_number AS "blockNumber", reason, posted_at AS "postedAt"`;

export async function recordRefund(
  pool: Pool, chain: RefundChain, intentId: string, transactionHash: Hash, logIndex: number, note: string,
) {
  const reason = note.trim();
  const hash = transactionHash.toLowerCase() as Hash;
  if (!/^0x[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(logIndex) ||
      logIndex < 0 || logIndex > 2147483647 || !reason || reason.length > 500) {
    throw new PaymentError(400, 'INVALID_REFUND_REQUEST');
  }
  const readRefund = `SELECT ${fields} FROM payment_refunds WHERE intent_id = $1`;
  function replay(previous: Refund) {
    if (previous.transactionHash !== hash || previous.logIndex !== logIndex || previous.reason !== reason) {
      throw new PaymentError(409, 'REFUND_ALREADY_RECORDED');
    }
    return previous;
  }

  const { rows: [existing] } = await pool.query<Refund>(readRefund, [intentId]);
  if (existing) return replay(existing);
  const { rows: [payment] } = await pool.query<Payment>(`
    SELECT j.network, j.asset, j.payer, lower(i.payee) AS payee, j.transaction_hash AS original_hash, j.amount
    FROM payment_journal j JOIN payment_intents i ON i.id = j.intent_id
    WHERE j.intent_id = $1 AND i.status = 'SETTLED'
  `, [intentId]);
  if (!payment) throw new PaymentError(409, 'SETTLED_PAYMENT_REQUIRED');
  if (payment.network !== 'eip155:84532' || payment.asset !== baseSepoliaUsdc || hash === payment.original_hash) {
    throw new PaymentError(422, 'INVALID_REFUND_EVIDENCE');
  }

  const [refundReceipt, original, finalized] = await Promise.all([
    chain.receipt(hash), chain.receipt(payment.original_hash), chain.finalized(),
  ]);
  if (refundReceipt.blockNumber > finalized) throw new PaymentError(409, 'REFUND_NOT_FINALIZED');
  const transfer = refundReceipt.logs.find((log) => log.logIndex === logIndex);
  if (refundReceipt.status !== 'success' || original.status !== 'success' ||
      refundReceipt.blockNumber < original.blockNumber ||
      (refundReceipt.blockNumber === original.blockNumber && refundReceipt.transactionIndex <= original.transactionIndex) ||
      !transfer || transfer.address.toLowerCase() !== payment.asset ||
      transfer.from.toLowerCase() !== payment.payee || transfer.to.toLowerCase() !== payment.payer ||
      transfer.amount !== BigInt(payment.amount)) {
    throw new PaymentError(422, 'INVALID_REFUND_EVIDENCE');
  }
  const [refundBlock, originalBlock] = await Promise.all([
    chain.blockHash(refundReceipt.blockNumber), chain.blockHash(original.blockNumber),
  ]);
  if (refundBlock !== refundReceipt.blockHash || originalBlock !== original.blockHash) {
    throw new PaymentError(422, 'INVALID_REFUND_EVIDENCE');
  }

  return transaction(pool, async (client) => {
    await client.query('SELECT intent_id FROM payment_journal WHERE intent_id = $1 FOR UPDATE', [intentId]);
    const { rows: [previous] } = await client.query<Refund>(readRefund, [intentId]);
    if (previous) return replay(previous);
    await lockIncomingTransfer(client, payment.network, hash, logIndex);
    const funding = await client.query(`SELECT 1 FROM wallet_funding
      WHERE network = $1 AND transaction_hash = $2 AND log_index = $3`, [payment.network, hash, logIndex]);
    if (funding.rowCount) throw new PaymentError(409, 'REFUND_TRANSFER_ALREADY_USED');

    const { rows: [inserted] } = await client.query<Refund>(`
      INSERT INTO payment_refunds (intent_id, network, transaction_hash, log_index, block_number, block_hash, reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (network, transaction_hash, log_index) DO NOTHING
      RETURNING ${fields}
    `, [intentId, payment.network, hash, logIndex, String(refundReceipt.blockNumber), refundBlock, reason]);
    if (!inserted) throw new PaymentError(409, 'REFUND_TRANSFER_ALREADY_USED');
    return inserted;
  });
}
