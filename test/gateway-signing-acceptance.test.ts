import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { evidenceDigest } from '../src/gateway-balance-evidence.js';
import { verifyModernSigningAcceptance } from '../src/verify-gateway-signing-acceptance.js';
import { assessBatchLinkage } from '../src/gateway-batch-linkage.js';

const artifact=new URL('../../docs/evidence/stage-6-modern-signing.json',import.meta.url);

test('live modern signing capture replays with one signature, one journal and complete linkage',async()=>{
  const saved=JSON.parse(await readFile(artifact,'utf8'));
  const replay=verifyModernSigningAcceptance(saved);
  assert.equal(replay.verified,true);assert.equal(replay.linkage,'corroborated');
  assert.equal(saved.signing.signatureRows,1);assert.equal(saved.signing.journalRows,1);
  assert.equal(saved.signing.budget.limit,'1000');assert.equal(saved.signing.budget.reserved,'0');
  function check(value:unknown) {
    if(!value||typeof value!=='object')return;
    for(const [key,item] of Object.entries(value)) {
      assert.ok(!['signature','privateKey','password','agentToken','retrieval_token','retrievalToken'].includes(key));check(item);
    }
  }
  check(saved);
});

test('a rehashed acceptance report still rejects changed authorization, counts, budget and linkage',async()=>{
  const original=JSON.parse(await readFile(artifact,'utf8'));
  for(const mutate of [
    (x:typeof original)=>{x.signing.authorization.nonce=`0x${'0'.repeat(64)}`;},
    (x:typeof original)=>{x.signing.signatureRows=2;},
    (x:typeof original)=>{x.signing.budget.limit='2000';},
    (x:typeof original)=>{x.signing.signatureMatches=false;},
    (x:typeof original)=>{x.signing.submittedAt='2000-01-01T00:00:00.000Z';},
    (x:typeof original)=>{x.batch.purchase.id='different-request';},
  ]) {
    const saved=structuredClone(original);mutate(saved);const {digest,...payload}=saved;saved.digest=evidenceDigest(payload);
    assert.throws(()=>verifyModernSigningAcceptance(saved));
  }
});

test('evidence digest survives JSON serialization of dates, omitted fields and array holes',()=>{
  const input={time:new Date('2026-11-17T00:00:00Z'),omitted:undefined,nested:{z:1,a:2},array:[undefined,NaN,3]};
  const persisted=JSON.parse(JSON.stringify(input));
  assert.equal(evidenceDigest(input),evidenceDigest(persisted));
  assert.equal(evidenceDigest({b:1,a:2}),evidenceDigest({a:2,b:1}));
  assert.throws(()=>evidenceDigest(undefined),/JSON representation/);
});

test('versioned review packet preserves provenance and source hashes without claiming model evaluation',async()=>{
  const root=new URL('../../benchmarks/batch-investigation-review-v1/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
  for(const [path,expected] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(path,root))).digest('hex'),expected);
  }
  for(const [path,expected] of Object.entries(manifest.sourceFiles)) {
    assert.equal(createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex'),expected);
  }
  assert.equal(manifest.annotationStatus,'single-author; independent review pending');
  assert.equal(manifest.modelEvaluationRun,false);
  const inputs=JSON.parse(await readFile(new URL('inputs.json',root),'utf8'));
  const labels=JSON.parse(await readFile(new URL('labels.json',root),'utf8'));
  const provenance=JSON.parse(await readFile(new URL('provenance.json',root),'utf8'));
  assert.equal(inputs.length,12);assert.equal(new Set(inputs.map((x:{id:string})=>x.id)).size,12);
  assert.equal(provenance.filter((x:{kind:string})=>x.kind==='captured').length,2);
  assert.equal(provenance.filter((x:{kind:string})=>x.kind==='synthetic-variation').length,10);
  for(const row of inputs) {
    const label=labels.find((x:{id:string})=>x.id===row.id);assert.ok(label);
    let status:string;
    try {status=assessBatchLinkage(row.input.snapshot,row.input.purchase,row.input.journal,row.input.observations)[0]?.status??'incomplete';}
    catch {status='conflict';}
    assert.equal(status,label.expectedStatus,row.id);
    for(const pointer of label.evidencePaths) {
      let value:unknown=row.input;
      for(const key of pointer.slice(1).split('/'))value=(value as Record<string,unknown>)[key];
      assert.notEqual(value,undefined,`${row.id}:${pointer}`);
    }
  }
});

test('blind reviewer export contains inputs and blank annotations without answer keys or provenance hints',()=>{
  const exported=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/export-batch-investigation-review.mjs',import.meta.url))],{encoding:'utf8'}));
  assert.equal(exported.status,'unreviewed');assert.equal(exported.cases.length,12);
  for(const row of exported.cases) {
    assert.deepEqual(row.review,{status:null,requiredChecks:[],evidencePaths:[],notes:''});
    assert.equal(row.expectedStatus,undefined);assert.equal(row.rationale,undefined);assert.equal(row.provenance,undefined);
  }
});
