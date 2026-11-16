import type { PoolClient } from 'pg';
import { verifyBalanceEvidence } from './gateway-balance-evidence.js';
import type { BalanceSnapshot } from './reconcile-gateway-balances.js';

// SELECT-only, called in the collector's repeatable-read transaction. Neither a
// model-provided scan ID nor a wallet-only match grants access to another task.
export async function collectPurchaseBalanceEvidence(client: PoolClient, purchase: {
  id: string; nonce: string; network: string; payer: string;
}) {
  const { rows } = await client.query<{
    scanId: string; capturedAt: Date; snapshot: BalanceSnapshot; digest: string; result: unknown;
  }>(`SELECT e.scan_id AS "scanId",e.captured_at AS "capturedAt",e.snapshot,e.digest,s.result
    FROM gateway_balance_evidence e JOIN gateway_balance_scans s ON s.id=e.scan_id
    WHERE s.network=$1 AND s.payer=$2 AND s.status IN ('matched','discrepancy')
      AND e.snapshot->>'network'=$1 AND e.snapshot->>'payer'=$2
      AND (e.snapshot->'purchases') @> $3::jsonb
    ORDER BY e.captured_at DESC,e.scan_id DESC LIMIT 3`,
  [purchase.network, purchase.payer.toLowerCase(), JSON.stringify([{ requestId: purchase.id, nonce: purchase.nonce,
      network: purchase.network, payer: purchase.payer.toLowerCase() }])]);
  return rows.map((saved) => {
    const reference = { scanId: saved.scanId, capturedAt: saved.capturedAt.toISOString(), digest: saved.digest };
    try {
      const replay = verifyBalanceEvidence(saved.scanId, saved);
      if (saved.snapshot.ledgerScope === 'none') throw new Error('Chain-only sample cannot support a purchase');
      const batches = replay.report.batches.filter((batch) => batch.requestIds.includes(purchase.id));
      return { ...reference, verification: 'verified' as const, source: replay.source,
        window: replay.report.window, balance: replay.report.balance,
        batches: batches.map(({ requestIds, ...batch }) => ({ ...batch, includesRequest: true })),
        missingBatches: replay.report.missingBatches.filter((batch) => batch.requestIds.includes(purchase.id))
          .map(({ requestIds, ...batch }) => ({ ...batch, includesRequest: true })),
        eventReferences: saved.snapshot.movements.batches.filter((batch) => batches.some((row) => row.hash === batch.hash))
          .map((batch) => ({ transactionHash: batch.hash, logIndex: batch.logIndex ?? null,
            blockNumber: batch.evidence?.blockNumber ?? null, blockHash: batch.evidence?.blockHash ?? null })),
        limitation: 'Historical wallet-level reconciliation, not individual payment finality or current wallet solvency.' };
    } catch {
      return { ...reference, verification: 'failed' as const,
        reason: 'Saved balance evidence failed replay validation; no balance or settlement conclusion is available.' };
    }
  });
}
