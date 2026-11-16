import type { Pool } from 'pg';
import type { Address, Hash } from 'viem';
import { captureBalanceSample } from './capture-gateway-balance-sample.js';
import { assessBatchLinkage, type BatchPurchaseTerms, type BatchJournal } from './gateway-batch-linkage.js';
import { gatewayBalanceChain } from './gateway-balance-chain.js';
import { evidenceDigest, verifyBalanceEvidence } from './gateway-balance-evidence.js';
import { observeGatewayPayment } from './gateway-reconciliation.js';
import { replayBalanceSnapshot, type Purchase } from './reconcile-gateway-balances.js';

// Requires an existing journal posting. Never migrates, reconciles, signs or pays.
export async function captureProjectBatch(pool: Pool, requestId: string) {
  const client=await pool.connect();
  let purchase: BatchPurchaseTerms;
  let journal: NonNullable<BatchJournal>;
  let postings: Purchase[];
  let networkProvenance: string;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const version=Number((await client.query('SELECT max(version) AS version FROM schema_migrations')).rows[0]?.version);
    networkProvenance=version<20?'legacy-pre-020-testnet-default':'explicit-purchase-network';
    const {rows:[row]}=await client.query(`SELECT p.request_id AS id,p.nonce,p.payer,p.recipient,coalesce(to_jsonb(p)->>'network','arcTestnet') AS network,
      p.amount_units::text AS "amountUnits",
      CASE WHEN to_jsonb(p)->'signing_authorization' IS NULL OR to_jsonb(p)->'signing_authorization'='null'::jsonb THEN NULL
        ELSE jsonb_build_object('from',to_jsonb(p)->'signing_authorization'->'from',
          'to',to_jsonb(p)->'signing_authorization'->'to','value',to_jsonb(p)->'signing_authorization'->'value',
          'nonce',to_jsonb(p)->'signing_authorization'->'nonce') END AS authorization,
      j.batch_hash AS "batchHash",j.amount::text AS "journalAmount",j.transfer_id AS "transferId"
      FROM gateway_demo_purchases p JOIN gateway_payment_journal j USING(request_id) WHERE p.request_id=$1
      AND (to_jsonb(p)->>'network' IS NOT NULL OR $2::boolean)`,[requestId,version<20]);
    if (!row || row.network!=='arcTestnet') throw new Error('An existing Arc testnet purchase and journal are required');
    purchase={id:row.id,nonce:row.nonce,payer:row.payer,recipient:row.recipient,network:row.network,
      amountUnits:row.amountUnits,authorization:row.authorization};
    journal={batchHash:row.batchHash,amount:row.journalAmount,transferId:row.transferId};
    // Retain all wallet journal postings, so multiple requests in the batch are not silently discarded.
    postings=(await client.query<Purchase>(`SELECT p.request_id AS "requestId",p.nonce,p.payer,p.recipient,coalesce(to_jsonb(p)->>'network','arcTestnet') AS network,
      p.amount_units::text AS "amountUnits",p.budget_status AS "budgetStatus",j.batch_hash AS "batchHash",j.amount::text AS "journalAmount"
      FROM gateway_demo_purchases p JOIN gateway_payment_journal j USING(request_id)
      WHERE coalesce(to_jsonb(p)->>'network','arcTestnet')='arcTestnet' AND p.payer=$1 ORDER BY p.request_id`,[row.payer])).rows;
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  const gateway=await observeGatewayPayment({...purchase,network:'arcTestnet'});
  const chain=await gatewayBalanceChain('arcTestnet');
  const block=await chain.receiptBlock(journal.batchHash as Hash);
  if (block===null) throw new Error('Journal batch receipt unavailable');
  const sample=await captureBalanceSample(purchase.payer as Address,block,block);
  const snapshot=structuredClone(sample.snapshot);
  snapshot.ledgerScope='wallet';snapshot.purchases=postings;
  for (const hash of new Set(postings.map((row)=>row.batchHash!))) {
    if (!snapshot.movements.batches.some((batch)=>batch.hash===hash)) snapshot.receiptBlocks[hash]=(await chain.receiptBlock(hash))?.toString()??null;
  }
  const result=replayBalanceSnapshot(snapshot);
  const saved={snapshot,digest:evidenceDigest(snapshot),result};
  const verification=verifyBalanceEvidence('project-capture',saved);
  const observations=[{id:'live-gateway-1',evidence:gateway}];
  const archive={version:1,capturedAt:new Date().toISOString(),scope:'project-journal-read-only',networkProvenance,
    limitation:'Journal-backed wallet rows only; unjournaled authorizations are outside this capture. Original authorization fields may be absent in legacy rows.',
    purchase,journal,observations,...saved,batchValidation:verification.batchValidation,
    linkage:assessBatchLinkage(snapshot,purchase,journal,observations)};
  return {...archive,captureDigest:evidenceDigest(archive)};
}
