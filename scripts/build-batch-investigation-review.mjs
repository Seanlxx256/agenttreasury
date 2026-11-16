import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { verifyProjectBatchEvidence } from '../dist/src/gateway-project-batch-evidence.js';
import { verifyModernSigningAcceptance } from '../dist/src/verify-gateway-signing-acceptance.js';
const root=new URL('../benchmarks/batch-investigation-review-v1/',import.meta.url);
const legacyPath='docs/evidence/stage-5-project-batch.json';
const modernPath='docs/evidence/stage-6-modern-signing.json';
const legacy=JSON.parse(await readFile(new URL('../'+legacyPath,import.meta.url),'utf8'));
const modern=JSON.parse(await readFile(new URL('../'+modernPath,import.meta.url),'utf8'));
verifyProjectBatchEvidence(legacy);verifyModernSigningAcceptance(modern);
const select=(source)=>structuredClone({purchase:source.purchase,journal:source.journal,observations:source.observations,snapshot:source.snapshot});
const cases=[],labels=[],provenance=[];
function add(base,kind,mutate,status,checks,paths,rationale) {
  const id=`case-${String(cases.length+1).padStart(2,'0')}`;
  const input=select(base==='modern'?modern.batch:legacy);mutate(input);
  cases.push({id,input});labels.push({id,expectedStatus:status,requiredChecks:checks,evidencePaths:paths,rationale});
  provenance.push({id,kind,baseArtifact:base==='modern'?modernPath:legacyPath});
}
add('modern','captured',()=>{},'corroborated',['read-balance-evidence'],['/purchase/authorization','/journal','/observations','/snapshot/movements/batches'],
  'Recorded request fields, Gateway reference and aggregate batch accounting agree; individual nonce inclusion is not proven.');
add('legacy','captured',()=>{},'incomplete',['read-original-authorization'],['/purchase/authorization'],
  'The real legacy purchase lacks its original signing authorization.');
add('modern','synthetic-variation',(x)=>{x.observations=[];},'incomplete',['read-gateway-status'],['/observations'],
  'A journal and a matching wallet delta cannot replace missing per-transfer Gateway evidence.');
add('modern','synthetic-variation',(x)=>{x.journal.amount='1001';},'conflict',['read-local-journal','compare-transfer-terms'],['/journal/amount','/purchase/amountUnits'],
  'The journal amount differs from the request.');
add('modern','synthetic-variation',(x)=>{x.purchase.authorization.nonce=`0x${'d'.repeat(64)}`;},'conflict',['read-original-authorization','compare-transfer-terms'],['/purchase/authorization/nonce','/purchase/nonce'],
  'The saved authorization nonce does not bind this request.');
add('modern','synthetic-variation',(x)=>{x.purchase.authorization.to=`0x${'d'.repeat(40)}`;},'conflict',['read-original-authorization','compare-transfer-terms'],['/purchase/authorization/to','/purchase/recipient'],
  'The authorization payee differs from the request recipient.');
add('modern','synthetic-variation',(x)=>{x.observations[0].evidence.txHash=`0x${'d'.repeat(64)}`;},'conflict',['read-chain-receipt','compare-transfer-terms'],['/observations/0/evidence/txHash','/journal/batchHash'],
  'The Gateway assertion refers to a different transaction.');
add('modern','synthetic-variation',(x)=>{x.snapshot.movements.batches[0].delta='-999';},'conflict',['read-batch-calldata','read-balance-evidence'],['/snapshot/movements/batches/0/delta','/snapshot/movements/batches/0/evidence/transactionInput'],
  'The normalized delta contradicts the archived raw calldata.');
add('modern','synthetic-variation',(x)=>{delete x.snapshot.movements.batches[0].evidence;},'incomplete',['read-batch-calldata'],['/snapshot/movements/batches/0'],
  'The normalized batch entry lacks raw evidence for validation.');
add('modern','synthetic-variation',(x)=>{x.observations.push({id:'synthetic-failed',evidence:{status:'failed'}});},'conflict',['read-gateway-status','read-local-journal'],['/observations','/journal'],
  'A failure assertion conflicts with charged and journaled evidence; it is not permission to refund or release budget.');
add('modern','synthetic-variation',(x)=>{x.snapshot.purchases.find((p)=>p.requestId===x.purchase.id).budgetStatus='reserved';},'conflict',['read-local-journal'],['/snapshot/purchases'],
  'The captured journal posting has not consumed its reservation.');
add('modern','synthetic-variation',(x)=>{delete x.purchase.authorization.nonce;},'incomplete',['read-original-authorization'],['/purchase/authorization'],
  'A partially recorded authorization is missing evidence, not evidence of a wrong nonce.');
await mkdir(root,{recursive:true});
const files={};
for(const [name,value] of Object.entries({'inputs.json':cases,'labels.json':labels,'provenance.json':provenance})) {
  const text=JSON.stringify(value,null,2)+'\n';await writeFile(new URL(name,root),text,{flag:'wx'});
  files[name]=createHash('sha256').update(text).digest('hex');
}
const sourceFiles={};
for(const name of [legacyPath,modernPath])sourceFiles[name]=createHash('sha256').update(await readFile(new URL('../'+name,import.meta.url))).digest('hex');
await writeFile(new URL('manifest.json',root),JSON.stringify({version:1,cases:12,capturedCases:2,syntheticVariations:10,
  frozenAt:new Date().toISOString(),purpose:'Review packet; not a blind benchmark',
  annotationStatus:'single-author; independent review pending',modelEvaluationRun:false,files,sourceFiles},null,2)+'\n',{flag:'wx'});
console.log('Created a versioned review packet. Do not silently regenerate it after review or evaluation.');
