import { evidenceDigest, verifyBalanceEvidence } from './gateway-balance-evidence.js';
import { assessBatchLinkage, type BatchPurchaseTerms, type BatchJournal, type BatchObservation } from './gateway-batch-linkage.js';
import type { BalanceSnapshot } from './reconcile-gateway-balances.js';

export function verifyProjectBatchEvidence(saved: {
  version: number; scope: string; captureDigest: string; networkProvenance: string; capturedAt: string;
  purchase: BatchPurchaseTerms; journal: BatchJournal; observations: BatchObservation[];
  snapshot: BalanceSnapshot; digest: string; result: unknown; linkage: unknown; batchValidation: unknown;
}) {
  const {captureDigest,...payload}=saved;
  if (saved.version!==1 || saved.scope!=='project-journal-read-only' || saved.purchase.network!=='arcTestnet' ||
      saved.snapshot.network!=='arcTestnet' || saved.snapshot.ledgerScope!=='wallet') throw new Error('Not a testnet project batch capture');
  if (evidenceDigest(payload)!==captureDigest) throw new Error('Project capture digest mismatch');
  const replay=verifyBalanceEvidence('project-capture',saved);
  const linkage=assessBatchLinkage(saved.snapshot,saved.purchase,saved.journal,saved.observations);
  if (!linkage.length || evidenceDigest(linkage)!==evidenceDigest(saved.linkage) ||
      evidenceDigest(replay.batchValidation)!==evidenceDigest(saved.batchValidation)) throw new Error('Project capture linkage differs on replay');
  return {...replay,capturedAt:saved.capturedAt,networkProvenance:saved.networkProvenance,linkage};
}
