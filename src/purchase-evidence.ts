import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { isAddress, isHash } from 'viem';
import { baseSepolia } from 'viem/chains';
import { reconcilePayments } from './reconciliation.js';
import type { ReconciliationChain } from './reconciliation.js';
import { purchaseResearch } from './research-client.js';

export async function collectPurchaseEvidence(
  pool: Pool, chain: ReconciliationChain, purchase: Parameters<typeof purchaseResearch>[0],
  polling?: Parameters<typeof purchaseResearch>[1],
) {
  const first = await purchaseResearch(purchase, polling);
  const replay = await purchaseResearch(purchase, polling);
  if (!isDeepStrictEqual(first, replay)) throw new Error('Purchase replay returned different delivery or ledger data');

  const journal = first.ledger?.journal;
  const hash = journal?.transactionHash;
  const payer = journal?.payer;
  const intentId = first.ledger?.intentId;
  if (first.ledger?.status !== 'SETTLED' || typeof intentId !== 'string' ||
      typeof hash !== 'string' || !isHash(hash) || typeof payer !== 'string' || !isAddress(payer)) {
    throw new Error('Expected a settled ledger with valid chain evidence');
  }

  const block = await chain.transactionBlock(hash);
  if (block === null) throw new Error('Settlement receipt is unavailable');
  const reconciliation = await reconcilePayments(pool, chain, payer, block, block);
  const purchaseMatches = reconciliation.matched.filter((match) =>
    match.intentId === intentId && match.transactionHash === hash,
  );
  const transfersForTransaction = [
    ...reconciliation.matched, ...reconciliation.discrepancies,
  ].filter((transfer) => transfer.transactionHash === hash && transfer.logIndex !== undefined);

  return {
    status: reconciliation.status === 'MATCHED' && purchaseMatches.length === 1 &&
      transfersForTransaction.length === 1 ? 'PASSED' : 'FAILED',
    purchaseId: purchase.requestId,
    transactionUrl: `${baseSepolia.blockExplorers.default.url}/tx/${hash}`,
    delivery: first.delivery,
    ledger: first.ledger,
    reconciliation,
  };
}
