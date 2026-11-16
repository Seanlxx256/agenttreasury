import type { BalanceSnapshot } from './reconcile-gateway-balances.js';
import { replayBalanceSnapshot } from './reconcile-gateway-balances.js';
import { validateRecordedBatches } from './gateway-batch-evidence.js';

export type BatchPurchaseTerms = {
  id: string; nonce: string; network: string; payer: string; recipient: string; amountUnits: string;
  authorization?: { from?: unknown; to?: unknown; value?: unknown; nonce?: unknown } | null;
};
export type BatchJournal = { batchHash: string; amount: string; transferId: string } | null;
export type BatchObservation = { id: string; evidence: { status: string; id?: string; txHash?: string | null } };
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

// Advisory consistency checks. None grants spending, refund or case-closure authority.
export function assessBatchLinkage(snapshot: BalanceSnapshot, purchase: BatchPurchaseTerms,
  journal: BatchJournal, observations: BatchObservation[]) {
  if (snapshot.ledgerScope === 'none') return [];
  const rows = snapshot.purchases.filter((row) => row.requestId === purchase.id);
  if (rows.length !== 1 || !rows[0]!.batchHash) return [];
  const original = rows[0]!;
  const batchHash = original.batchHash!;
  const report = replayBalanceSnapshot(snapshot);
  const batch = report.batches.find((row) => same(row.hash,batchHash));
  const validation = validateRecordedBatches(snapshot).find((row) => same(row.hash,batchHash));
  const historicalTerms = snapshot.network===purchase.network && same(snapshot.payer,purchase.payer) && same(original.nonce,purchase.nonce) && same(original.payer,purchase.payer) &&
    same(original.recipient,purchase.recipient) && original.network===purchase.network && original.amountUnits===purchase.amountUnits
    ? 'matched' : 'mismatch';
  const auth = purchase.authorization;
  const authorizationTerms = !auth || ![auth.from,auth.to,auth.value,auth.nonce].every((value)=>typeof value==='string' && value.length>0) ? 'unavailable' : same(auth.from,purchase.payer) && same(auth.to,purchase.recipient) &&
    same(auth.nonce,purchase.nonce) && auth.value===purchase.amountUnits ? 'matched' : 'mismatch';
  const journalBinding = !journal ? 'missing' : same(journal.batchHash,batchHash) &&
    journal.amount===purchase.amountUnits && original.journalAmount===journal.amount && original.budgetStatus==='spent'
    ? 'matched' : 'mismatch';
  const charged = observations.filter((row) => row.evidence.status==='charged');
  const conflicting = observations.some((row) => ['conflict','failed'].includes(row.evidence.status)) ||
    charged.some((row) => !same(row.evidence.txHash,batchHash) || (journal && row.evidence.id!==journal.transferId));
  const gatewayReference = conflicting ? 'conflict' : charged.length && journal ? 'matched' : 'missing';
  const walletAccounting = !batch ? 'missing' : batch.status==='MATCHED' ? 'matched' : 'mismatch';
  const rawBatchConsistency = validation?.status==='verified' ? 'verified' : 'unavailable';
  const states = [historicalTerms,authorizationTerms,journalBinding,gatewayReference,walletAccounting];
  const status = states.some((state)=>state==='mismatch' || state==='conflict') ? 'conflict'
    : states.every((state)=>state==='matched') && rawBatchConsistency==='verified' ? 'corroborated' : 'incomplete';
  return [{ batchHash,status,historicalTerms,authorizationTerms,journalBinding,gatewayReference,walletAccounting,rawBatchConsistency,
    observationIds: observations.filter((row)=>['charged','conflict','failed'].includes(row.evidence.status)).map((row)=>row.id),
    cryptographicAuthorizationInclusion:false,
    limitation:'Corroboration uses local authorization fields, local journal and normalized Gateway assertions. Net wallet deltas do not prove inclusion of an individual nonce, validate its signature, or establish payee entitlement.' }];
}
