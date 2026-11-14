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

export interface ReconciliationChain {
  finalized(): Promise<bigint>;
  blockHash(block: bigint): Promise<Hash>;
  outgoing(payer: Address, fromBlock: bigint, toBlock: bigint): Promise<Transfer[]>;
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

  const transfersByHash = new Map<Hash, Map<number, Transfer>>();
  for (const transfer of await chain.outgoing(wallet, fromBlock, toBlock)) {
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

  if (await chain.blockHash(toBlock) !== endHash) throw new Error('Finalized block hash changed during reconciliation');
  const report = {
    network, asset: baseSepoliaUsdc, payer: wallet, fromBlock: String(fromBlock), toBlock: String(toBlock),
    toBlockHash: endHash, status: discrepancies.length === 0 ? 'MATCHED' : 'DISCREPANCY', matched, discrepancies,
  };
  await pool.query(`
    INSERT INTO reconciliation_runs (network, asset, payer, from_block, to_block, to_block_hash, report)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (network, asset, payer, from_block, to_block)
    DO UPDATE SET to_block_hash = EXCLUDED.to_block_hash, report = EXCLUDED.report, checked_at = now()
  `, [network, baseSepoliaUsdc, wallet, String(fromBlock), String(toBlock), endHash, report]);
  return report;
}
