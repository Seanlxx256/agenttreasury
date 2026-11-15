import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { isAddress, isHash, type Address, type Hash } from 'viem';
import { baseSepoliaUsdc } from './base-settlement.js';
import { lockIncomingTransfer, transaction } from './db.js';
import { PaymentError } from './payments.js';
import { baseRefundChain, type RefundChain } from './refunds.js';

export async function recordFunding(
  pool: Pool, chain: RefundChain, wallet: Address, transactionHash: Hash, logIndex: number, note: string,
) {
  const payer = wallet.toLowerCase();
  const hash = transactionHash.toLowerCase() as Hash;
  const reason = note.trim();
  if (!isAddress(wallet) || !isHash(hash) || !Number.isSafeInteger(logIndex) ||
      logIndex < 0 || logIndex > 2147483647 || !reason || reason.length > 500) {
    throw new PaymentError(400, 'INVALID_FUNDING_REQUEST');
  }
  const network = 'eip155:84532';
  const [receipt, finalized] = await Promise.all([chain.receipt(hash), chain.finalized()]);
  if (receipt.blockNumber > finalized) throw new PaymentError(409, 'FUNDING_NOT_FINALIZED');
  const transfer = receipt.logs.find((log) => log.logIndex === logIndex);
  if (receipt.status !== 'success' || !transfer || transfer.address.toLowerCase() !== baseSepoliaUsdc ||
      transfer.to.toLowerCase() !== payer || transfer.from.toLowerCase() === payer || transfer.amount <= 0n ||
      await chain.blockHash(receipt.blockNumber) !== receipt.blockHash) {
    throw new PaymentError(422, 'INVALID_FUNDING_EVIDENCE');
  }
  const evidence = [network, hash, logIndex];
  const sender = transfer.from.toLowerCase();
  const amount = String(transfer.amount);
  return transaction(pool, async (client) => {
    await lockIncomingTransfer(client, network, hash, logIndex);
    const refund = await client.query(`SELECT 1 FROM payment_refunds
      WHERE network = $1 AND transaction_hash = $2 AND log_index = $3`, evidence);
    if (refund.rowCount) throw new PaymentError(409, 'FUNDING_TRANSFER_ALREADY_USED');
    await client.query(`INSERT INTO wallet_funding
      (network, transaction_hash, log_index, asset, payer, sender, block_number, block_hash, amount, reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
    [...evidence, baseSepoliaUsdc, payer, sender, String(receipt.blockNumber), receipt.blockHash, amount, reason]);
    const { rows: journal } = await client.query(`SELECT * FROM funding_journal_lines
      WHERE network = $1 AND transaction_hash = $2 AND log_index = $3 ORDER BY number`, evidence);
    const entry = journal[0];
    if (!entry || entry.payer !== payer || entry.sender !== sender || entry.amount !== amount ||
        entry.block_number !== String(receipt.blockNumber) || entry.block_hash !== receipt.blockHash || entry.reason !== reason) {
      throw new PaymentError(409, 'FUNDING_ALREADY_RECORDED');
    }
    return { journal };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { DATABASE_URL, BASE_SEPOLIA_RPC_URL } = process.env;
  const [wallet, hash, index, reason] = process.argv.slice(2);
  if (!DATABASE_URL || !BASE_SEPOLIA_RPC_URL || !wallet || !isAddress(wallet) ||
      !hash || !isHash(hash) || !index || !/^\d+$/.test(index) || !reason) {
    throw new Error('Set DATABASE_URL and BASE_SEPOLIA_RPC_URL, then run npm run funding:record -- <wallet> <transaction-hash> <log-index> <reason>');
  }
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  try {
    const chain = await baseRefundChain(BASE_SEPOLIA_RPC_URL);
    console.log(JSON.stringify(await recordFunding(pool, chain, wallet, hash, Number(index), reason), null, 2));
  } finally {
    await pool.end();
  }
}
