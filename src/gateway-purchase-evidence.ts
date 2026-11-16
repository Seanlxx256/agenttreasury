import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { type Hash, isHash } from 'viem';
import { gatewayNetworkConfig } from './gateway-x402.js';
import { observeGatewayPayment, type ExpectedGatewayPayment } from './gateway-reconciliation.js';

type Receipt = { status: 'success' | 'reverted'; blockNumber: bigint };
type PurchaseRecord = ExpectedGatewayPayment & {
  taskId: string | null;
  budgetStatus: string | null;
  submitted: boolean;
  buyerDelivery: unknown;
  sellerDelivery: unknown;
  commitmentSatisfied: boolean | null;
  commitmentViolations: string[] | null;
  entries: { side: string; account: string; amount: string; transferId: string; batchHash: string }[] | null;
};

function matchesDelivery(payload: unknown, requestId: string, nonce: string) {
  return Boolean(payload && typeof payload === 'object' &&
    'requestId' in payload && payload.requestId === requestId &&
    'nonce' in payload && payload.nonce === nonce &&
    'gatewayReference' in payload && typeof payload.gatewayReference === 'string' && payload.gatewayReference.length &&
    'trace' in payload && payload.trace && typeof payload.trace === 'object' &&
    'source' in payload.trace && payload.trace.source === 'fixture');
}

export async function collectGatewayPurchaseEvidence(
  pool: Pool,
  requestId: string,
  readReceipt: (hash: Hash) => Promise<Receipt | null>,
  request: typeof fetch = fetch,
) {
  const { rows: [purchase] } = await pool.query<PurchaseRecord>(`
    SELECT p.nonce, p.payer, p.recipient, p.amount_units::text AS "amountUnits", p.network,
           p.task_id AS "taskId", p.budget_status AS "budgetStatus", p.submitted_at IS NOT NULL AS submitted,
           p.delivery AS "buyerDelivery", d.delivery AS "sellerDelivery",
           p.commitment_satisfied AS "commitmentSatisfied", p.commitment_violations AS "commitmentViolations",
           (SELECT jsonb_agg(jsonb_build_object(
              'side', l.side, 'account', l.account, 'amount', l.amount::text,
              'transferId', l.transfer_id, 'batchHash', l.batch_hash
            ) ORDER BY l.number) FROM gateway_payment_journal_lines l WHERE l.request_id = p.request_id) AS entries
    FROM gateway_demo_purchases p
    LEFT JOIN gateway_demo_deliveries d ON d.request_id = p.request_id AND d.nonce = p.nonce
    WHERE p.request_id = $1
  `, [requestId]);
  if (!purchase) throw new Error('Gateway purchase not found');

  const { nonce, payer, recipient, amountUnits, network, taskId, budgetStatus, submitted,
    buyerDelivery, sellerDelivery, commitmentSatisfied, commitmentViolations, entries } = purchase;
  const gateway = await observeGatewayPayment({ nonce, payer, recipient, amountUnits, network }, request);
  const hash = gateway.status === 'charged' && isHash(gateway.txHash) ? gateway.txHash : null;
  const receipt = hash ? await readReceipt(hash) : null;
  const problems: string[] = [];
  const pending: string[] = [];
  if (!taskId || !submitted) problems.push('Expected a task-backed purchase with a submission marker.');
  if (gateway.status === 'conflict' || gateway.status === 'failed') problems.push('Gateway evidence: ' + gateway.status);
  if (gateway.status === 'pending' || gateway.status === 'unknown') pending.push('Awaiting Gateway confirmation.');

  if (buyerDelivery === null || sellerDelivery === null) pending.push('Awaiting saved buyer and seller deliveries.');
  if ((buyerDelivery !== null && !matchesDelivery(buyerDelivery, requestId, nonce)) ||
      (sellerDelivery !== null && !matchesDelivery(sellerDelivery, requestId, nonce)) ||
      (buyerDelivery !== null && sellerDelivery !== null && !isDeepStrictEqual(buyerDelivery, sellerDelivery))) {
    problems.push('Saved deliveries do not match the purchase.');
  }
  if (commitmentSatisfied === false) {
    const detail = commitmentViolations?.length ? `: ${commitmentViolations.join('; ')}` : '';
    problems.push(`Delivery commitment not satisfied${detail}`);
  }

  if (budgetStatus === 'reserved' && !entries) pending.push('Awaiting budget and journal posting.');
  else if (budgetStatus !== 'spent' || !entries) problems.push('Expected spent budget and a posted journal.');
  if (entries) {
    const [debit, credit] = entries;
    if (entries.length !== 2 || debit?.side !== 'DEBIT' || debit.account !== 'DATA_PROCUREMENT_EXPENSE' ||
        credit?.side !== 'CREDIT' || credit.account !== 'USDC_GATEWAY_ASSET' ||
        entries.some((entry) => entry.amount !== amountUnits || entry.transferId !== debit.transferId ||
          entry.batchHash !== debit.batchHash) ||
        (gateway.status === 'charged' && (debit.transferId !== gateway.id || debit.batchHash !== gateway.txHash))) {
      problems.push('Journal does not balance or match the Gateway transfer.');
    }
  }
  if (receipt?.status === 'reverted') problems.push('The Arc batch transaction reverted.');
  if (hash && !receipt) pending.push('Arc batch receipt is not available yet.');

  const chainConfig = gatewayNetworkConfig(network).chainConfig;
  return {
    status: problems.length ? 'FAILED' : pending.length ? 'PENDING' : 'PASSED',
    requestId, nonce, payer, recipient, amountUnits, taskId, budgetStatus,
    gateway, journal: entries,
    delivery: { buyerSaved: buyerDelivery !== null, sellerSaved: sellerDelivery !== null },
    commitment: { satisfied: commitmentSatisfied, violations: commitmentViolations ?? [] },
    batch: hash && chainConfig.blockExplorers ? {
      hash, explorerUrl: chainConfig.blockExplorers.default.url + '/tx/' + hash,
      receiptStatus: receipt?.status ?? null,
      blockNumber: receipt?.blockNumber.toString() ?? null,
    } : null,
    problems, pending,
  };
}
