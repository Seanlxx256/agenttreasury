import { verifyProjectBatchEvidence } from '../src/gateway-project-batch-evidence.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { evidenceDigest, verifyBalanceEvidence } from '../src/gateway-balance-evidence.js';
import { validateRecordedBatches } from '../src/gateway-batch-evidence.js';
import { assessBatchLinkage, type BatchPurchaseTerms, type BatchJournal, type BatchObservation } from '../src/gateway-batch-linkage.js';
import { replayBalanceSnapshot, type BalanceSnapshot } from '../src/reconcile-gateway-balances.js';

const sample=JSON.parse(await readFile(new URL('../../docs/evidence/stage-5-live-batch.json',import.meta.url),'utf8'));

// Real archived chain evidence combined with explicitly synthetic local bindings.
// These generated terms do not claim to describe the public wallet's actual payments.
function fixture() {
  const snapshot=structuredClone(sample.snapshot) as BalanceSnapshot;
  snapshot.ledgerScope='wallet';snapshot.source={kind:'fixture',chainId:5042002};
  const batch=snapshot.movements.batches[0]!;
  const amount=String(-BigInt(batch.delta));
  const purchase: BatchPurchaseTerms={id:'00000000-0000-4000-8000-000000000001',nonce:`0x${'a'.repeat(64)}`,
    payer:snapshot.payer,recipient:`0x${'b'.repeat(40)}`,network:'arcTestnet',amountUnits:amount};
  purchase.authorization={from:purchase.payer,to:purchase.recipient,nonce:purchase.nonce,value:amount};
  snapshot.purchases=[{requestId:purchase.id,nonce:purchase.nonce,payer:purchase.payer,recipient:purchase.recipient,
    network:'arcTestnet',amountUnits:amount,budgetStatus:'spent',batchHash:batch.hash,journalAmount:amount}];
  const journal:NonNullable<BatchJournal>={batchHash:batch.hash,amount,transferId:'synthetic-transfer'};
  const observations:BatchObservation[]=[{id:'fixture-observation',evidence:{status:'charged',id:journal.transferId,txHash:batch.hash}}];
  return {snapshot,purchase,journal,observations};
}

test('real batch raw calldata and log explain the wallet decrease, not a business discrepancy', () => {
  const report=verifyBalanceEvidence('real-batch',sample);
  assert.equal(report.ledgerScope,'none');
  assert.equal(report.batchValidation[0]!.status,'verified');
  assert.equal(report.report.balance.batchDelta,'-132');
  assert.equal(report.report.balance.chainDifference,'0');
  assert.equal(report.report.balance.journalDifference,'-132');
  assert.equal(report.report.status,'DISCREPANCY');
  assert.equal(sample.snapshot.purchases.length,0);
});

test('recomputed digests cannot conceal a normalized delta or event/calldata mismatch', () => {
  for (const mutate of [
    (s:BalanceSnapshot)=>{s.movements.batches[0]!.delta='-131';},
    (s:BalanceSnapshot)=>{s.movements.batches[0]!.id=`0x${'0'.repeat(64)}`;},
    (s:BalanceSnapshot)=>{s.movements.batches[0]!.evidence!.address=`0x${'0'.repeat(40)}`;},
    (s:BalanceSnapshot)=>{s.movements.batches[0]!.evidence!.transactionInput='0x';},
  ]) {
    const snapshot=structuredClone(sample.snapshot);mutate(snapshot);
    assert.throws(()=>verifyBalanceEvidence('tampered',{snapshot,digest:evidenceDigest(snapshot),result:replayBalanceSnapshot(snapshot)}));
  }
});

test('agreement is corroboration only; alternate allocations have the same aggregate chain evidence', () => {
  const f=fixture();
  const full=assessBatchLinkage(f.snapshot,f.purchase,f.journal,f.observations)[0]!;
  assert.equal(full.status,'corroborated');assert.equal(full.cryptographicAuthorizationInclusion,false);
  f.purchase.amountUnits='100';f.purchase.authorization!.value='100';f.journal.amount='100';
  f.snapshot.purchases[0]!.amountUnits='100';f.snapshot.purchases[0]!.journalAmount='100';
  f.snapshot.purchases.push({...f.snapshot.purchases[0]!,requestId:'synthetic-other',nonce:`0x${'c'.repeat(64)}`,
    amountUnits:'32',journalAmount:'32'});
  const split=assessBatchLinkage(f.snapshot,f.purchase,f.journal,f.observations)[0]!;
  assert.equal(split.status,'corroborated');assert.equal(split.cryptographicAuthorizationInclusion,false);
  assert.deepEqual(f.snapshot.movements,sample.snapshot.movements);
});

test('wrong nonce, amount, recipient, transfer ID or batch hash produces a conflict', () => {
  for (const mutate of [
    (f:ReturnType<typeof fixture>)=>{f.purchase.authorization!.nonce=`0x${'d'.repeat(64)}`;},
    (f:ReturnType<typeof fixture>)=>{f.purchase.authorization!.value='999';},
    (f:ReturnType<typeof fixture>)=>{f.purchase.authorization!.to=`0x${'d'.repeat(40)}`;},
    (f:ReturnType<typeof fixture>)=>{f.journal.amount='999';},
    (f:ReturnType<typeof fixture>)=>{f.observations[0]!.evidence.id='different-transfer';},
    (f:ReturnType<typeof fixture>)=>{f.observations[0]!.evidence.txHash=`0x${'d'.repeat(64)}`;},
    (f:ReturnType<typeof fixture>)=>{f.observations.push({id:'conflict',evidence:{status:'conflict'}});},
    (f:ReturnType<typeof fixture>)=>{f.snapshot.purchases[0]!.recipient=`0x${'d'.repeat(40)}`;},
  ]) {
    const f=fixture();mutate(f);
    assert.equal(assessBatchLinkage(f.snapshot,f.purchase,f.journal,f.observations)[0]!.status,'conflict');
  }
});

test('missing authorization, Gateway assertion or raw batch evidence cannot pass as corroborated', () => {
  const f=fixture();f.purchase.authorization=null;
  assert.equal(assessBatchLinkage(f.snapshot,f.purchase,f.journal,f.observations)[0]!.status,'incomplete');
  f.purchase.authorization={from:f.purchase.payer};
  assert.equal(assessBatchLinkage(f.snapshot,f.purchase,f.journal,f.observations)[0]!.status,'incomplete');
  const g=fixture();g.observations=[];
  assert.equal(assessBatchLinkage(g.snapshot,g.purchase,g.journal,g.observations)[0]!.status,'incomplete');
  const h=fixture();delete h.snapshot.movements.batches[0]!.evidence;
  assert.equal(validateRecordedBatches(h.snapshot)[0]!.status,'unavailable');
  assert.equal(assessBatchLinkage(h.snapshot,h.purchase,h.journal,h.observations)[0]!.status,'incomplete');
  h.snapshot.ledgerScope='none';
  assert.deepEqual(assessBatchLinkage(h.snapshot,h.purchase,h.journal,h.observations),[]);
});


test('archived project purchase replays matched ledger and Gateway linkage without inventing legacy authorization', async () => {
  const archive=JSON.parse(await readFile(new URL('../../docs/evidence/stage-5-project-batch.json',import.meta.url),'utf8'));
  const replay=verifyProjectBatchEvidence(archive);
  assert.equal(replay.report.status,'MATCHED');
  assert.equal(replay.report.balance.chainDifference,'0');
  assert.equal(replay.report.balance.journalDifference,'0');
  assert.equal(replay.linkage[0]!.authorizationTerms,'unavailable');
  assert.equal(replay.linkage[0]!.journalBinding,'matched');
  assert.equal(replay.linkage[0]!.gatewayReference,'matched');
  assert.equal(replay.linkage[0]!.status,'incomplete');
  assert.equal(replay.linkage[0]!.cryptographicAuthorizationInclusion,false);
  const changed=structuredClone(archive);changed.observations[0].evidence.id='altered';
  assert.throws(()=>verifyProjectBatchEvidence(changed),/capture digest mismatch/);
  const {captureDigest,...payload}=changed;changed.captureDigest=evidenceDigest(payload);
  assert.throws(()=>verifyProjectBatchEvidence(changed),/linkage differs/);
});
