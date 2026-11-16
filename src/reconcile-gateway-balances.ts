import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { isAddress, type Address, type Hash } from 'viem';
import { gatewayBalanceChain, type GatewayBalanceChain } from './gateway-balance-chain.js';
import { observeGatewayPayment, type ExpectedGatewayPayment } from './gateway-reconciliation.js';
import { gatewayNetworkConfig } from './gateway-x402.js';

type Purchase = ExpectedGatewayPayment & {
  requestId: string;
  batchHash: Hash | null;
  journalAmount: string | null;
  budgetStatus: 'reserved' | 'spent' | 'released' | null;
};

export async function reconcileGatewayBalances(
  pool: Pool, chain: GatewayBalanceChain, payer: Address, from: bigint, to: bigint, request: typeof fetch = fetch,
) {
  if (from < 1n || to < from || to - from >= 2000n) throw new Error('Specify an inclusive range of 1 to 2000 blocks after deployment');
  if (to > await chain.finalized()) throw new Error('Gateway balance reconciliation requires a finalized end block');
  const networkConfig = gatewayNetworkConfig(chain.network);
  const wallet = payer.toLowerCase() as Address;
  const openingBlock = from - 1n;
  const [openingHash, closingHash] = await Promise.all([chain.blockHash(openingBlock), chain.blockHash(to)]);
  const [{ rows: purchases }, opening, closing] = await Promise.all([
    pool.query<Purchase>(`
      SELECT p.request_id AS "requestId", p.nonce, p.payer, p.recipient, p.amount_units::text AS "amountUnits",
        p.network, p.budget_status AS "budgetStatus", j.batch_hash AS "batchHash", j.amount::text AS "journalAmount"
      FROM gateway_demo_purchases p LEFT JOIN gateway_payment_journal j USING (request_id)
      WHERE p.payer = $1 AND (p.submitted_at IS NOT NULL OR j.request_id IS NOT NULL)
      ORDER BY p.request_id
    `, [wallet]),
    chain.totalBalance(wallet, openingBlock),
    chain.totalBalance(wallet, to),
  ]);
  const chainMoves = await chain.movements(wallet, from, to);

  const postings = new Map<Hash, Purchase[]>();
  for (const purchase of purchases) {
    if (!purchase.batchHash) continue;
    const group = postings.get(purchase.batchHash) ?? [];
    group.push(purchase);
    postings.set(purchase.batchHash, group);
  }

  let journalDebits = 0n;
  const batches = chainMoves.batches.map((batch) => {
    const group = postings.get(batch.hash) ?? [];
    postings.delete(batch.hash);
    const booked = group.reduce((sum, row) => sum + BigInt(row.journalAmount!), 0n);
    journalDebits += booked;
    const validPostings = group.every((row) => row.journalAmount === row.amountUnits && row.budgetStatus === 'spent');
    return { hash: batch.hash, id: batch.id, onchainDelta: String(batch.delta), journalDelta: String(-booked),
      requestIds: group.map((row) => row.requestId),
      status: group.length && validPostings && batch.delta === -booked ? 'MATCHED' : 'DISCREPANCY' };
  });

  const missingBatches = [];
  for (const [hash, group] of postings) {
    const block = await chain.receiptBlock(hash);
    if (block !== null && (block < from || block > to)) continue;
    if (block !== null) journalDebits += group.reduce((sum, row) => sum + BigInt(row.journalAmount!), 0n);
    missingBatches.push({ hash, block: block?.toString() ?? null, requestIds: group.map((row) => row.requestId) });
  }

  // These are current observations. Never apply them to either historical balance.
  const unsettled = [];
  for (const purchase of purchases) {
    if (purchase.batchHash || purchase.budgetStatus === 'released') continue;
    try {
      const evidence = await observeGatewayPayment(purchase, request);
      if (evidence.status !== 'failed') {
        unsettled.push({ requestId: purchase.requestId, nonce: purchase.nonce, amount: purchase.amountUnits, evidence });
      }
    } catch {
      unsettled.push({ requestId: purchase.requestId, nonce: purchase.nonce, amount: purchase.amountUnits,
        evidence: { status: 'unavailable' } });
    }
  }
  const pendingAmount = unsettled.reduce((sum, row) => row.evidence.status === 'pending' ? sum + BigInt(row.amount) : sum, 0n);
  const deposits = chainMoves.deposits.reduce((sum, row) => sum + row.amount, 0n);
  const withdrawals = chainMoves.withdrawals.reduce((sum, row) => sum + row.amount, 0n);
  const burns = chainMoves.burns.reduce((sum, row) => sum + row.amount, 0n);
  const batchDelta = chainMoves.batches.reduce((sum, row) => sum + row.delta, 0n);
  const capital = deposits - withdrawals - burns;
  const chainClosing = opening + capital + batchDelta;
  const journalClosing = opening + capital - journalDebits;
  const balancesMatch = chainClosing === closing && journalClosing === closing;
  const [currentOpeningHash, currentClosingHash] = await Promise.all([chain.blockHash(openingBlock), chain.blockHash(to)]);
  if (currentOpeningHash !== openingHash || currentClosingHash !== closingHash) throw new Error('Finalized block hash changed during reconciliation');
  const status = balancesMatch && !missingBatches.length && batches.every((batch) => batch.status === 'MATCHED')
    ? 'MATCHED' : 'DISCREPANCY';
  const serializeMovements = (rows: typeof chainMoves.deposits) =>
    rows.map((row) => ({ ...row, amount: String(row.amount) }));
  return {
    status, network: networkConfig.network, token: networkConfig.usdc, payer: wallet,
    window: { openingBlock: String(openingBlock), openingHash, from: String(from), to: String(to), closingHash },
    balance: { opening: String(opening), closing: String(closing), deposits: String(deposits),
      withdrawals: String(withdrawals), burns: String(burns), batchDelta: String(batchDelta),
      journalDebits: String(journalDebits), chainClosing: String(chainClosing), journalClosing: String(journalClosing),
      chainDifference: String(closing - chainClosing), journalDifference: String(closing - journalClosing) },
    capitalMovements: { deposits: serializeMovements(chainMoves.deposits), withdrawals: serializeMovements(chainMoves.withdrawals),
      burns: serializeMovements(chainMoves.burns) },
    batches, missingBatches,
    currentAuthorizations: { pendingAmount: String(pendingAmount), unresolved: unsettled },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [payer, from, to, ...extra] = process.argv.slice(2);
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL || !payer || !isAddress(payer) || !from || !to || !/^\d+$/.test(from) || !/^\d+$/.test(to) || extra.length) {
    throw new Error('Set DATABASE_URL and run npm run reconcile:gateway-balances -- <payer> <from-block> <to-block>');
  }
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  try {
    const report = await reconcileGatewayBalances(pool, await gatewayBalanceChain(), payer, BigInt(from), BigInt(to));
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'DISCREPANCY') process.exitCode = 2;
  } finally {
    await pool.end();
  }
}
