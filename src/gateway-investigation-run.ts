import { collectPurchaseBalanceEvidence } from './gateway-investigation-balance.js';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Hash } from 'viem';
import { PaymentError } from './payments.js';
import { runGuidedChecks } from './gateway-guided-investigation.js';
import { prepareGatewayTriage } from './gateway-triage.js';
import { observeGatewayPayment } from './gateway-reconciliation.js';
import { gatewayClient, gatewayNetworkConfig, type GatewayNetworkName } from './gateway-x402.js';
import { suggestInvestigationsWithModel, validateInvestigationPlan,
  type InvestigationFact, type InvestigationKind, type InvestigationSuggestion } from './gateway-investigation.js';

export async function collectInvestigationSnapshot(pool: Pool, requestId: string) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows:[purchase] }=await client.query(`SELECT p.request_id AS id,p.task_id AS "taskId",p.nonce,p.payer,p.recipient,
      p.network,p.amount_units::text AS "amountUnits",p.budget_status AS "budgetStatus",p.authorized_at AS "authorizedAt",
      CASE WHEN p.signing_authorization IS NULL THEN NULL ELSE jsonb_build_object(
        'from',p.signing_authorization->'from','to',p.signing_authorization->'to','value',p.signing_authorization->'value',
        'nonce',p.signing_authorization->'nonce','validAfter',p.signing_authorization->'validAfter','validBefore',p.signing_authorization->'validBefore') END AS "authorization",p.signing_started_at AS "signingStartedAt",p.submitted_at AS "submittedAt",
      p.reconcile_review_at IS NOT NULL AS "reviewRequired",p.delivery IS NOT NULL AS "buyerHasDelivery",
      EXISTS(SELECT 1 FROM gateway_demo_deliveries d WHERE d.request_id=p.request_id AND d.nonce=p.nonce) AS "sellerHasDelivery",
      p.commitment_satisfied AS "commitmentSatisfied",t.enabled AS "taskEnabled",t.active_until AS "taskActiveUntil",
      t.reserved::text AS "taskReserved",t.spent::text AS "taskSpent",t.budget::text AS "taskBudget"
      FROM gateway_demo_purchases p LEFT JOIN research_tasks t ON t.id=p.task_id WHERE p.request_id=$1`,[requestId]);
    if (!purchase) throw new PaymentError(404,'GATEWAY_PURCHASE_NOT_FOUND');
    const { rows:observations }=await client.query(`SELECT id::text,checked_at AS "observedAt",source,
      jsonb_build_object('status',evidence->'status','reason',left(evidence->>'reason',2000),
        'id',evidence->'id','txHash',evidence->'txHash') AS evidence FROM (
        (SELECT * FROM gateway_payment_observations WHERE request_id=$1 ORDER BY id DESC LIMIT 10)
        UNION (SELECT * FROM gateway_payment_observations WHERE request_id=$1 AND evidence->>'status' IN ('charged','failed','conflict')
          ORDER BY id DESC LIMIT 1)) selected ORDER BY selected.id DESC`,[requestId]);
    const { rows:[journal] }=await client.query(`SELECT request_id AS "requestId",transfer_id AS "transferId",
      batch_hash AS "batchHash",amount::text,posted_at AS "postedAt" FROM gateway_payment_journal WHERE request_id=$1`,[requestId]);
    const { rows:journalLines }=await client.query(`SELECT number,account,side,amount::text
      FROM gateway_payment_journal_lines WHERE request_id=$1 ORDER BY number`,[requestId]);
    if (journal) journal.lines=journalLines;
    const { rows:[refund] }=await client.query(`SELECT q.status,q.requested_at AS "requestedAt",q.decided_at AS "decidedAt",
      a.status AS "broadcastStatus",a.transaction_hash AS "submittedHash",r.transaction_hash AS "recordedHash"
      FROM gateway_demo_purchases p LEFT JOIN gateway_refund_requests q ON q.request_id=p.request_id
      LEFT JOIN gateway_refund_authorizations a ON a.request_id=p.request_id
      LEFT JOIN gateway_payment_refunds r ON r.request_id=p.request_id WHERE p.request_id=$1
      AND (q.request_id IS NOT NULL OR a.request_id IS NOT NULL OR r.request_id IS NOT NULL)`,[requestId]);
    const { rows:[merchant] }=await client.query(`SELECT g.merchant_id AS id,g.recipient AS "grantRecipient",
      g.approved_recipient_version AS "grantVersion",m.recipient AS "currentRecipient",m.recipient_change_version AS "currentVersion"
      FROM gateway_task_grants g LEFT JOIN gateway_merchants m ON m.id=g.merchant_id WHERE g.task_id=$1`,[purchase.taskId]);
    const balanceEvidence = await collectPurchaseBalanceEvidence(client, purchase, journal ?? null, observations);
    await client.query('COMMIT');
    const records={ purchase,balanceEvidence,observations,journal:journal ?? null,refund:refund ?? null,merchant:merchant ?? null };
    const prepared=prepareGatewayTriage({...purchase,journal:records.journal},observations);
    const facts: InvestigationFact[]=prepared.facts.map(({id,description})=>({id,description}));
    if (balanceEvidence.length) facts.push({id:'balance-evidence',description:'Saved historical balance evidence is linked to this request; inspect replay verification before drawing conclusions.'});
    if (refund) facts.push({id:'refund',description:'A refund workflow record exists; its status must be inspected.'});
    if (merchant) facts.push({id:'merchant-recipient',description:'A merchant-bound grant is recorded for this purchase.'});
    if (purchase.signingStartedAt) facts.push({id:'signing',description:'Signing started; this is not proof of merchant submission.'});
    const sources=Object.fromEntries(facts.map((fact)=>[fact.id,
      fact.id.startsWith('observation-') ? `gateway_payment_observations:${fact.id.slice(12)}` :
      fact.id==='balance-evidence' ? `gateway_balance_evidence:${balanceEvidence.map((row)=>row.scanId).join(',')}` :
      fact.id==='journal' ? `gateway_payment_journal:${requestId}` :
      fact.id==='refund' ? `gateway_refund_requests:${requestId}` :
      fact.id==='merchant-recipient' ? `gateway_task_grants:${purchase.taskId}` : `purchase-snapshot:${requestId}`]));
    return {requestId,capturedAt:new Date().toISOString(),fingerprint:createHash('sha256').update(JSON.stringify(records)).digest('hex'),
      records,facts,sources,ruleAction:prepared.rules};
  } catch(error) { await client.query('ROLLBACK');throw error; }
  finally {client.release();}
}

type Snapshot=Awaited<ReturnType<typeof collectInvestigationSnapshot>>;

export async function checkInvestigationFreshness(pool: Pool, requestId: string, fingerprint: string) {
  try {
    const current = await collectInvestigationSnapshot(pool, requestId);
    const stale = current.fingerprint !== fingerprint;
    return { stale, status: stale ? 'changed' as const : 'unchanged' as const, checkedAt: current.capturedAt };
  } catch {
    // Keep an already collected report readable. Unknown must not become false.
    return { stale: null, status: 'unavailable' as const, checkedAt: null };
  }
}
export type InvestigationToolResult={
  kind:InvestigationKind; citations:string[]; evidenceId:string; observedAt:string;
  status:'ok'|'blocked'|'unavailable'; source:string; data?:unknown; reason?:string;
};
type ChainRead=(kind:'read-chain-receipt'|'read-batch-calldata',network:GatewayNetworkName,hash:Hash)=>Promise<unknown>;

const readChain:ChainRead=async(kind,network,hash)=>{
  const client=gatewayClient(network);
  if (await client.getChainId()!==gatewayNetworkConfig(network).chainConfig.id) throw new Error('RPC network mismatch');
  if (kind==='read-chain-receipt') {
    const receipt=await client.getTransactionReceipt({hash});
    return {hash:receipt.transactionHash,blockHash:receipt.blockHash,blockNumber:String(receipt.blockNumber),status:receipt.status,
      interpretation:'Receipt status alone does not prove this individual payment was settled.'};
  }
  const tx=await client.getTransaction({hash});
  return {hash:tx.hash,to:tx.to,blockNumber:tx.blockNumber===null ? null : String(tx.blockNumber),
    input:tx.input.slice(0,8194),truncated:tx.input.length>8194,
    interpretation:'Raw transaction input; no per-payment settlement claim is inferred.'};
};

async function bounded<T>(read:()=>Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Read deadline')),6000);})]);}
  finally {clearTimeout(timer);}
}

export async function executeInvestigationChecks(snapshot:Snapshot, plan:InvestigationSuggestion[],options:{
  refreshExternal?:boolean; gatewayRequest?:typeof fetch; chainRead?:ChainRead;
}={}) {
  if (!validateInvestigationPlan({investigations:plan},snapshot.facts)) throw new PaymentError(400,'INVALID_INVESTIGATION_PLAN');
  const {purchase,journal,merchant,refund,observations}=snapshot.records;
  const results:InvestigationToolResult[]=[];
  for (const step of plan) {
    const result:InvestigationToolResult={...step,evidenceId:`tool-${results.length+1}`,observedAt:new Date().toISOString(),
      status:'ok',source:`snapshot:${snapshot.fingerprint}`};
    switch(step.kind) {
      case 'read-original-authorization': result.data=purchase;break;
      case 'read-balance-evidence': {
        const evidence = snapshot.records.balanceEvidence;
        result.data={evidence};
        result.source=`gateway_balance_evidence:${evidence.map((row)=>row.scanId).join(',')}`;
        if (evidence.some((row)=>row.verification!=='verified')) {
          result.status='unavailable';result.reason='At least one linked snapshot failed replay verification.';
        }
        break;
      }
      case 'read-local-journal': result.data={journal};break;
      case 'read-refund-status': result.data={refund};break;
      case 'read-merchant-recipient': result.data={merchant};break;
      case 'compare-transfer-terms': result.data={
        original:{nonce:purchase.nonce,payer:purchase.payer,recipient:purchase.recipient,network:purchase.network,amountUnits:purchase.amountUnits},
        journalAmountMatches:journal ? journal.amount===purchase.amountUnits : null,
        merchantGrantCurrent:merchant?.id ? merchant.grantRecipient===merchant.currentRecipient && merchant.grantVersion===merchant.currentVersion : null,
        gatewayObservations:observations,
        limitation:'Normalized Gateway observations do not contain all raw transfer terms; missing fields are not a match.',
      };break;
      default: {
        if (!options.refreshExternal || purchase.network!=='arcTestnet') {
          result.status='blocked';result.reason='External reads require explicit opt-in and an Arc testnet purchase.';break;
        }
        try {
          if (step.kind==='read-gateway-status') {
            result.source=`gateway:${purchase.network}:nonce:${purchase.nonce}`;
            result.data=await bounded(()=>observeGatewayPayment(purchase,options.gatewayRequest));
          } else {
            const hash=journal?.batchHash ?? observations.find((row)=>row.evidence.status==='charged')?.evidence.txHash;
            if (typeof hash!=='string' || !/^0x[0-9a-f]{64}$/i.test(hash)) {
              result.status='blocked';result.reason='No transaction hash is bound to this snapshot.';break;
            }
            result.source=`rpc:${purchase.network}:transaction:${hash}`;
            result.data=await bounded(()=>(options.chainRead ?? readChain)(step.kind as 'read-chain-receipt'|'read-batch-calldata',purchase.network,hash as Hash));
          }
        } catch {result.status='unavailable';result.reason='Read failed or timed out; no payment conclusion was inferred.';}
        result.observedAt=new Date().toISOString();
      }
    }
    results.push(result);
  }
  return results;
}

export async function runGatewayInvestigation(pool:Pool,requestId:string,options:{
  model?:string;modelRequest?:typeof fetch;refreshExternal?:boolean;gatewayRequest?:typeof fetch;chainRead?:ChainRead; guided?:boolean;
}={}) {
  const start=Date.now();
  const snapshot=await collectInvestigationSnapshot(pool,requestId);
  if (options.guided) {
    const guided = await runGuidedChecks(snapshot.facts, async (step) => (await executeInvestigationChecks(snapshot, [step], options))[0]!, {
      model: options.model, request: options.modelRequest,
      isFresh: async () => (await collectInvestigationSnapshot(pool, requestId)).fingerprint === snapshot.fingerprint,
    });
    const freshness = await checkInvestigationFreshness(pool, requestId, snapshot.fingerprint);
    if (['checklist-collected', 'no-applicable-checks'].includes(guided.stopReason) && freshness.status !== 'unchanged') {
      guided.stopReason = freshness.status === 'changed' ? 'snapshot-changed' : 'freshness-unavailable';
    }
    return { version: 1, advisoryOnly: true, snapshot, planner: { status: 'guided', investigations: guided.checks.map(({ kind, citations }) => ({ kind, citations })) },
      checks: guided.checks, guided, staleAtCompletion: freshness.stale, completionFreshness: freshness.status,
      freshnessCheckedAt: freshness.checkedAt, durationMs: Date.now() - start,
      summary: { requested: guided.required.length, completed: guided.checks.filter((c) => c.status === 'ok').length,
        blocked: guided.checks.filter((c) => c.status === 'blocked').length, unavailable: guided.checks.filter((c) => c.status === 'unavailable').length },
      limitation: guided.scope };
  }
  const planner=await suggestInvestigationsWithModel(snapshot.facts,options.model,options.modelRequest);
  const checks=await executeInvestigationChecks(snapshot,planner.investigations,options);
  const current=await collectInvestigationSnapshot(pool,requestId);
  return {version:1,advisoryOnly:true,snapshot,planner,checks,staleAtCompletion:snapshot.fingerprint!==current.fingerprint,
    freshnessCheckedAt:current.capturedAt,durationMs:Date.now()-start,
    summary:{requested:checks.length,completed:checks.filter((r)=>r.status==='ok').length,
      blocked:checks.filter((r)=>r.status==='blocked').length,unavailable:checks.filter((r)=>r.status==='unavailable').length},
    limitation:'Checks gather evidence only. No automatic root-cause verdict, case closure, payment, refund or budget adjustment.'};
}
