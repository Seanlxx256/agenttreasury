import type { Pool } from 'pg';
import { createPublicClient, http, parseAbiItem, TransactionReceiptNotFoundError } from 'viem';
import type { Address, Hash } from 'viem';
import { baseSepolia } from 'viem/chains';
import { baseSepoliaUsdc } from './base-settlement.js';

interface Transfer {
  transactionHash: Hash;
  logIndex: number;
  recipient: string;
  amount: bigint;
}

interface IncomingTransfer {
  transactionHash: Hash;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hash;
  sender: string;
  amount: bigint;
}

export interface ReconciliationChain {
  finalized(): Promise<bigint>;
  blockHash(block: bigint): Promise<Hash>;
  outgoing(payer: Address, fromBlock: bigint, toBlock: bigint): Promise<Transfer[]>;
  incoming(payer: Address, fromBlock: bigint, toBlock: bigint): Promise<IncomingTransfer[]>;
  transactionBlock(hash: Hash): Promise<bigint | null>;
}

export async function baseReconciliationChain(rpc: string): Promise<ReconciliationChain> {
  const client = createPublicClient({
    chain: baseSepolia, transport: http(rpc, { timeout: 5000, retryCount: 1 }),
  });
  if (await client.getChainId() !== baseSepolia.id) throw new Error('RPC endpoint must serve Base Sepolia');
  const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

  return {
    async finalized() {
      return (await client.getBlock({ blockTag: 'finalized' })).number;
    },
    async blockHash(blockNumber) {
      return (await client.getBlock({ blockNumber })).hash;
    },
    async outgoing(payer, fromBlock, toBlock) {
      const logs = await client.getLogs({
        address: baseSepoliaUsdc, event: transfer, args: { from: payer }, fromBlock, toBlock, strict: true,
      });
      return logs.map((log) => ({
        transactionHash: log.transactionHash, logIndex: log.logIndex,
        recipient: log.args.to.toLowerCase(), amount: log.args.value,
      }));
    },
    async incoming(payer, fromBlock, toBlock) {
      const logs = await client.getLogs({
        address: baseSepoliaUsdc, event: transfer, args: { to: payer }, fromBlock, toBlock, strict: true,
      });
      return logs.map((log) => ({
        transactionHash: log.transactionHash, logIndex: log.logIndex,
        blockNumber: log.blockNumber, blockHash: log.blockHash,
        sender: log.args.from.toLowerCase(), amount: log.args.value,
      }));
    },
    async transactionBlock(hash) {
      try {
        return (await client.getTransactionReceipt({ hash })).blockNumber;
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
  };
}

interface Posting {
  intent_id: string;
  transaction_hash: Hash;
  recipient: string;
  amount: string;
}

export async function reconcilePayments(
  pool: Pool, chain: ReconciliationChain, payer: Address, fromBlock: bigint, toBlock: bigint,
) {
  if (fromBlock < 0n || toBlock < fromBlock || toBlock - fromBlock >= 2000n) {
    throw new Error('Specify an inclusive range of 1 to 2000 blocks');
  }
  if (toBlock > await chain.finalized()) throw new Error('Reconciliation requires a finalized end block');
  const network = 'eip155:84532';
  const wallet = payer.toLowerCase() as Address;
  const endHash = await chain.blockHash(toBlock);
  const { rows: postings } = await pool.query<Posting>(`
    SELECT j.intent_id, j.transaction_hash, lower(i.payee) AS recipient, j.amount
    FROM payment_journal j JOIN payment_intents i ON i.id = j.intent_id
    WHERE j.network = $1 AND j.asset = $2 AND j.payer = $3 ORDER BY j.intent_id
  `, [network, baseSepoliaUsdc, wallet]);

  const { rows: refunds } = await pool.query<{
    intent_id: string; transaction_hash: Hash; log_index: number;
    block_number: string; block_hash: Hash; sender: string; amount: string;
  }>(`
    SELECT r.intent_id, r.transaction_hash, r.log_index, r.block_number, r.block_hash,
      lower(i.payee) AS sender, j.amount
    FROM payment_refunds r
    JOIN payment_journal j ON j.intent_id = r.intent_id
    JOIN payment_intents i ON i.id = r.intent_id
    WHERE r.network = $1 AND j.asset = $2 AND j.payer = $3 AND r.block_number BETWEEN $4 AND $5
    ORDER BY r.block_number, r.log_index, r.intent_id
  `, [network, baseSepoliaUsdc, wallet, String(fromBlock), String(toBlock)]);

  const [outgoing, incoming] = await Promise.all([
    chain.outgoing(wallet, fromBlock, toBlock), chain.incoming(wallet, fromBlock, toBlock),
  ]);
  const transfersByHash = new Map<Hash, Map<number, Transfer>>();
  for (const transfer of outgoing) {
    // Transaction hash plus log index identifies a transfer within this chain.
    const hash = transfer.transactionHash.toLowerCase() as Hash;
    let logs = transfersByHash.get(hash);
    if (!logs) {
      logs = new Map();
      transfersByHash.set(hash, logs);
    }
    logs.set(transfer.logIndex, transfer);
  }

  const matched: { intentId: string; transactionHash: Hash; logIndex: number }[] = [];
  const discrepancies: {
    code: 'JOURNAL_RECEIPT_UNAVAILABLE' | 'JOURNAL_TRANSFER_UNMATCHED' | 'CHAIN_TRANSFER_UNMATCHED';
    transactionHash: Hash;
    recipient: string;
    amount: string;
    intentId?: string;
    logIndex?: number;
  }[] = [];
  const unmatched: Posting[] = [];
  const located = new Map<Hash, bigint | null>();

  for (const posting of postings) {
    const hash = posting.transaction_hash;
    const logs = transfersByHash.get(hash);
    const matchingLog = logs && [...logs.values()].find(
      (log) => log.recipient === posting.recipient && log.amount === BigInt(posting.amount),
    );
    if (matchingLog) {
      logs!.delete(matchingLog.logIndex);
      matched.push({ intentId: posting.intent_id, transactionHash: hash, logIndex: matchingLog.logIndex });
    } else {
      unmatched.push(posting);
    }
  }

  for (const posting of unmatched) {
    const hash = posting.transaction_hash;
    if (!located.has(hash)) {
      located.set(hash, transfersByHash.has(hash) ? fromBlock : await chain.transactionBlock(hash));
    }
    const block = located.get(hash)!;
    if (block === null || (block >= fromBlock && block <= toBlock)) {
      discrepancies.push({
        code: block === null ? 'JOURNAL_RECEIPT_UNAVAILABLE' : 'JOURNAL_TRANSFER_UNMATCHED',
        intentId: posting.intent_id, transactionHash: hash, recipient: posting.recipient, amount: posting.amount,
      });
    }
  }

  for (const [transactionHash, logs] of transfersByHash) {
    for (const log of logs.values()) {
      discrepancies.push({
        code: 'CHAIN_TRANSFER_UNMATCHED', transactionHash, logIndex: log.logIndex,
        recipient: log.recipient, amount: String(log.amount),
      });
    }
  }

  const incomingByEvidence = new Map(incoming.map((log) => [
    `${log.transactionHash.toLowerCase()}:${log.logIndex}`, log,
  ]));
  const matchedRefunds: typeof matched = [];
  const refundDiscrepancies: {
    code: 'REFUND_TRANSFER_UNMATCHED' | 'UNCLASSIFIED_INCOMING_TRANSFER';
    transactionHash: Hash; logIndex: number; sender: string; amount: string; intentId?: string;
  }[] = [];
  for (const refund of refunds) {
    const key = `${refund.transaction_hash}:${refund.log_index}`;
    const log = incomingByEvidence.get(key);
    if (log && log.sender === refund.sender && log.amount === BigInt(refund.amount) &&
        log.blockNumber === BigInt(refund.block_number) && log.blockHash === refund.block_hash) {
      matchedRefunds.push({
        intentId: refund.intent_id, transactionHash: refund.transaction_hash, logIndex: refund.log_index,
      });
      incomingByEvidence.delete(key);
    } else {
      refundDiscrepancies.push({
        code: 'REFUND_TRANSFER_UNMATCHED', intentId: refund.intent_id,
        transactionHash: refund.transaction_hash, logIndex: refund.log_index,
        sender: refund.sender, amount: refund.amount,
      });
    }
  }
  for (const log of incomingByEvidence.values()) {
    refundDiscrepancies.push({
      code: 'UNCLASSIFIED_INCOMING_TRANSFER', transactionHash: log.transactionHash,
      logIndex: log.logIndex, sender: log.sender, amount: String(log.amount),
    });
  }

  if (await chain.blockHash(toBlock) !== endHash) throw new Error('Finalized block hash changed during reconciliation');
  const report = {
    network, asset: baseSepoliaUsdc, payer: wallet, fromBlock: String(fromBlock), toBlock: String(toBlock),
    toBlockHash: endHash,
    status: discrepancies.length + refundDiscrepancies.length === 0 ? 'MATCHED' : 'DISCREPANCY',
    matched, discrepancies, matchedRefunds, refundDiscrepancies,
  };
  await pool.query(`
    INSERT INTO reconciliation_runs (network, asset, payer, from_block, to_block, to_block_hash, report)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (network, asset, payer, from_block, to_block)
    DO UPDATE SET to_block_hash = EXCLUDED.to_block_hash, report = EXCLUDED.report, checked_at = now()
  `, [network, baseSepoliaUsdc, wallet, String(fromBlock), String(toBlock), endHash, report]);
  return report;
}
