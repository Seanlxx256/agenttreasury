import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { isAddress, type Address, type Hash } from 'viem';
import { gatewayBalanceChain, type GatewayBalanceChain } from './gateway-balance-chain.js';
import { observeGatewayPayment, type ExpectedGatewayPayment } from './gateway-reconciliation.js';
import { gatewayNetworkConfig } from './gateway-x402.js';

export type Purchase = ExpectedGatewayPayment & {
  requestId: string;
  batchHash: Hash | null;
  journalAmount: string | null;
  budgetStatus: 'reserved' | 'spent' | 'released' | null;
};

export type BalanceSnapshot = {
  version: 1;
  ledgerScope?: 'wallet' | 'none';
  network: GatewayBalanceChain['network'];
  payer: Address;
  from: string; to: string; finalized: string;
  openingHash: Hash; closingHash: Hash;
  opening: string; closing: string;
  purchases: Purchase[];
  movements: {
    deposits: Array<Omit<Awaited<ReturnType<GatewayBalanceChain['movements']>>['deposits'][number], 'amount'> & { amount: string }>;
    withdrawals: Array<Omit<Awaited<ReturnType<GatewayBalanceChain['movements']>>['withdrawals'][number], 'amount'> & { amount: string }>;
    burns: Array<Omit<Awaited<ReturnType<GatewayBalanceChain['movements']>>['burns'][number], 'amount'> & { amount: string }>;
    batches: Array<Omit<Awaited<ReturnType<GatewayBalanceChain['movements']>>['batches'][number], 'delta'> & { delta: string }>;
  };
  receiptBlocks: Record<string, string | null>;
  unsettled: Array<{ requestId: string; nonce: string; amount: string;
    evidence: Awaited<ReturnType<typeof observeGatewayPayment>> | { status: 'unavailable' } }>;
  source: NonNullable<GatewayBalanceChain['source']> | null;
};

export async function reconcileGatewayBalances(
  pool: Pool | null, chain: GatewayBalanceChain, payer: Address, from: bigint, to: bigint, request: typeof fetch = fetch,
  capture?: (snapshot: BalanceSnapshot) => void,
) {
  if (from < 1n || to < from || to - from >= 2000n) throw new Error('Specify an inclusive range of 1 to 2000 blocks after deployment');
  const finalized = await chain.finalized();
  if (to > finalized) throw new Error('Gateway balance reconciliation requires a finalized end block');
  const wallet = payer.toLowerCase() as Address;
  const openingBlock = from - 1n;
  const [openingHash, closingHash] = await Promise.all([chain.blockHash(openingBlock), chain.blockHash(to)]);
  const [{ rows: purchases }, opening, closing] = await Promise.all([
    pool ? pool.query<Purchase>(`
      SELECT p.request_id AS "requestId", p.nonce, p.payer, p.recipient, p.amount_units::text AS "amountUnits",
        p.network, p.budget_status AS "budgetStatus", j.batch_hash AS "batchHash", j.amount::text AS "journalAmount"
      FROM gateway_demo_purchases p LEFT JOIN gateway_payment_journal j USING (request_id)
      WHERE p.payer = $1 AND p.network = $2 AND (p.submitted_at IS NOT NULL OR p.signing_started_at IS NOT NULL OR j.request_id IS NOT NULL)
      ORDER BY p.request_id
    `, [wallet, chain.network]) : Promise.resolve({ rows: [] as Purchase[] }),
    chain.totalBalance(wallet, openingBlock),
    chain.totalBalance(wallet, to),
  ]);
  const chainMoves = await chain.movements(wallet, from, to);

  // Verify returned event block hashes against canonical headers before storing them.
  const eventBlocks = new Map<string, Hash>();
  for (const rows of Object.values(chainMoves)) for (const row of rows) {
    if (!row.evidence) continue;
    const { blockNumber, blockHash } = row.evidence;
    if (eventBlocks.has(blockNumber) && eventBlocks.get(blockNumber) !== blockHash) throw new Error('Conflicting event block hashes');
    eventBlocks.set(blockNumber, blockHash);
  }
  for (const [height, hash] of eventBlocks) {
    if (await chain.blockHash(BigInt(height)) !== hash) throw new Error('Event block hash is not canonical');
  }
  const receiptBlocks: Record<string, string | null> = {};
  const batchHashes = new Set(chainMoves.batches.map((row) => row.hash));
  for (const hash of new Set(purchases.flatMap((row) => row.batchHash && !batchHashes.has(row.batchHash) ? [row.batchHash] : []))) {
    receiptBlocks[hash] = (await chain.receiptBlock(hash))?.toString() ?? null;
  }
  // These are current observations. Never apply them to either historical balance.
  const unsettled: BalanceSnapshot['unsettled'] = [];
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
  const [currentOpeningHash, currentClosingHash] = await Promise.all([chain.blockHash(openingBlock), chain.blockHash(to)]);
  if (currentOpeningHash !== openingHash || currentClosingHash !== closingHash) throw new Error('Finalized block hash changed during reconciliation');
  const serialize = (rows: typeof chainMoves.deposits) => rows.map((row) => ({ ...row, amount: String(row.amount) }));
  const snapshot: BalanceSnapshot = {
    version: 1, ledgerScope: pool ? 'wallet' : 'none', network: chain.network, payer: wallet, from: String(from), to: String(to), finalized: String(finalized),
    openingHash, closingHash, opening: String(opening), closing: String(closing), purchases, receiptBlocks, unsettled,
    source: chain.source ?? null,
    movements: { deposits: serialize(chainMoves.deposits), withdrawals: serialize(chainMoves.withdrawals),
      burns: serialize(chainMoves.burns), batches: chainMoves.batches.map((row) => ({ ...row, delta: String(row.delta) })) },
  };
  const report = replayBalanceSnapshot(snapshot);
  capture?.(snapshot);
  return report;
}

// Pure calculation: no database, RPC, Gateway API or current-time dependency.
export function replayBalanceSnapshot(input: BalanceSnapshot) {
  if (input.version !== 1) throw new Error('Unsupported balance evidence version');
  const from = BigInt(input.from), to = BigInt(input.to), openingBlock = from - 1n;
  if (from < 1n || to < from || to - from >= 2000n || to > BigInt(input.finalized)) throw new Error('Invalid evidence window');
  const networkConfig = gatewayNetworkConfig(input.network);
  const wallet = input.payer, { openingHash, closingHash, purchases, unsettled } = input;
  const opening = BigInt(input.opening), closing = BigInt(input.closing);
  const restore = (rows: BalanceSnapshot['movements']['deposits']) => rows.map((row) => ({ ...row, amount: BigInt(row.amount) }));
  const chainMoves = { deposits: restore(input.movements.deposits), withdrawals: restore(input.movements.withdrawals),
    burns: restore(input.movements.burns), batches: input.movements.batches.map((row) => ({ ...row, delta: BigInt(row.delta) })) };
  const identities = new Set<string>();
  for (const rows of Object.values(chainMoves)) for (const row of rows) {
    if (row.logIndex === undefined) continue;
    const key = `${row.hash}:${row.logIndex}`;
    if (identities.has(key)) throw new Error('Duplicate event in balance input');
    identities.add(key);
  }
  if (new Set(chainMoves.batches.map((row) => row.hash)).size !== chainMoves.batches.length) {
    throw new Error('Ambiguous multiple Gateway batches in one transaction');
  }
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
    const block = input.receiptBlocks[hash] === null ? null : BigInt(input.receiptBlocks[hash]!);
    if (block !== null && (block < from || block > to)) continue;
    if (block !== null) journalDebits += group.reduce((sum, row) => sum + BigInt(row.journalAmount!), 0n);
    missingBatches.push({ hash, block: block?.toString() ?? null, requestIds: group.map((row) => row.requestId) });
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
