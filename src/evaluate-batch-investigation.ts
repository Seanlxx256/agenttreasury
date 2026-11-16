import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decideBatchRules, runBatchModel, validBatchDecision, type BatchEvalInput, type BatchDecision } from './batch-investigation-eval.js';
export const reviewRoot=new URL('../../benchmarks/batch-investigation-review-v1/',import.meta.url);
export const protocolRoot=new URL('../../benchmarks/batch-investigation-eval-v1/',import.meta.url);
export type EvalLabel={id:string;expectedStatus:BatchDecision['status'];requiredChecks:string[];evidencePaths:string[]};
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

export async function batchProtocolFiles() {
  const files:Record<string,string>={};const seen=new Set<string>();
  async function visit(name:string) {
    if(seen.has(name))return;seen.add(name);
    const source=await readFile(new URL('../../src/'+name+'.ts',import.meta.url),'utf8');
    files['src/'+name+'.ts']=sha(source);
    files['dist/src/'+name+'.js']=sha(await readFile(new URL(name+'.js',import.meta.url)));
    for(const match of source.matchAll(/from\s+['"]\.\/([^'"]+)\.js['"]/g))await visit(match[1]!);
  }
  await visit('evaluate-batch-investigation');
  for(const name of ['package-lock.json','benchmarks/batch-investigation-review-v1/inputs.json',
    'benchmarks/batch-investigation-review-v1/labels.json','benchmarks/batch-investigation-review-v1/provenance.json',
    'benchmarks/batch-investigation-review-v1/manifest.json','benchmarks/batch-investigation-eval-v1/protocol.json']) {
    files[name]=sha(await readFile(new URL('../../'+name,import.meta.url)));
  }
  return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
}
export async function verifyBatchProtocol() {
  const saved=JSON.parse(await readFile(new URL('manifest.json',protocolRoot),'utf8'));
  if(saved.node!==process.version)throw new Error('Node runtime differs from freeze');
  if(JSON.stringify(await batchProtocolFiles())!==JSON.stringify(saved.files))throw new Error('Frozen evaluation files changed; use a new protocol version');
  return saved;
}
export function scoreBatchDecision(decision:BatchDecision|null,label:EvalLabel,candidateStatus?:string|null) {
  const checks=[...new Set(decision?.checks??[])],citations=[...new Set(decision?.citations??[])];
  const checkMatches=checks.filter((value)=>label.requiredChecks.includes(value)).length;
  const pathMatches=citations.filter((value)=>label.evidencePaths.includes(value)).length;
  const statusCorrect=decision?.status===label.expectedStatus;
  return {statusCorrect,requiredCheckMatches:checkMatches,requiredCheckCount:label.requiredChecks.length,
    annotatedPathMatches:pathMatches,annotatedPathCount:label.evidencePaths.length,citations:citations.length,
    falseCorroboration:label.expectedStatus!=='corroborated'&&(decision?.status??candidateStatus)==='corroborated',
    strictSuccess:!!decision&&statusCorrect&&checkMatches===label.requiredChecks.length&&pathMatches===label.evidencePaths.length&&pathMatches===citations.length};
}
export function summarizeBatchScores(rows:Array<ReturnType<typeof scoreBatchDecision>>) {
  const sum=(key:'requiredCheckMatches'|'requiredCheckCount'|'annotatedPathMatches'|'annotatedPathCount'|'citations')=>rows.reduce((n,r)=>n+r[key],0);
  return {cases:rows.length,correct:rows.filter((r)=>r.statusCorrect).length,
    statusAccuracy:rows.filter((r)=>r.statusCorrect).length/rows.length,
    requiredCheckRecall:sum('requiredCheckCount')?sum('requiredCheckMatches')/sum('requiredCheckCount'):null,
    annotatedPathRecall:sum('annotatedPathCount')?sum('annotatedPathMatches')/sum('annotatedPathCount'):null,
    annotatedPathPrecision:sum('citations')?sum('annotatedPathMatches')/sum('citations'):null,
    strictSuccesses:rows.filter((r)=>r.strictSuccess).length,falseCorroborations:rows.filter((r)=>r.falseCorroboration).length};
}
export async function evaluateBatchInvestigation(models:string[]=[],request:typeof fetch=fetch,
  progress:(message:string)=>void=()=>{}) {
  const manifest=await verifyBatchProtocol();
  if(models.some((m)=>!manifest.models.some((row:{name:string})=>row.name===m)))throw new Error('Model not in the frozen protocol');
  let runtime:unknown=null;
  if(models.length) {
    const response=await request('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok)throw new Error('Cannot verify installed model digests');
    const tags=await response.json();
    for(const name of models) {
      const installed=tags.models?.find((row:{name:string})=>row.name===name);
      if(installed?.digest!==manifest.models.find((row:{name:string})=>row.name===name)?.digest)throw new Error('Model digest differs from freeze');
    }
    const version=await request('http://127.0.0.1:11434/api/version',{signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!version.ok)throw new Error('Cannot verify Ollama version');
    runtime=await version.json();
    if(JSON.stringify(runtime)!==JSON.stringify(manifest.ollama))throw new Error('Ollama runtime differs from freeze');
  }
  const inputs:Array<{id:string;input:BatchEvalInput}>=JSON.parse(await readFile(new URL('inputs.json',reviewRoot),'utf8'));
  const labels:EvalLabel[]=JSON.parse(await readFile(new URL('labels.json',reviewRoot),'utf8'));
  const rules=inputs.map((sample)=>{
    const start=performance.now();const decision=decideBatchRules(sample.input);
    if(!validBatchDecision(decision,sample.input))throw new Error('Rule output failed the same schema gate');
    return {id:sample.id,decision,durationMs:performance.now()-start,...scoreBatchDecision(decision,labels.find((l)=>l.id===sample.id)!)};
  });
  const results=[];
  for(const model of models) {
    const cases=[];
    for(const sample of inputs) {
      progress(`${model}: ${sample.id}/${inputs.length}`);
      const run=await runBatchModel(sample.input,model,request);
      cases.push({id:sample.id,...run,...scoreBatchDecision(run.decision,labels.find((l)=>l.id===sample.id)!,run.candidateStatus)});
    }
    results.push({model,summary:{...summarizeBatchScores(cases),ready:cases.filter((r)=>r.status==='ready').length,
      rejected:cases.filter((r)=>r.status==='rejected').length,unavailable:cases.filter((r)=>r.status==='unavailable').length,
      meanDurationMs:cases.reduce((n,r)=>n+r.durationMs,0)/cases.length,
      promptTokens:cases.reduce((n,r)=>n+(r.promptTokens??0),0),outputTokens:cases.reduce((n,r)=>n+(r.outputTokens??0),0),
      usageMissing:cases.filter((r)=>r.promptTokens===null||r.outputTokens===null).length},cases});
  }
  return {protocol:'batch-investigation-eval-v1',runAt:new Date().toISOString(),node:process.version,ollama:runtime,
    manifestDigest:sha(JSON.stringify(manifest)),models:manifest.models,rules:{summary:{...summarizeBatchScores(rules),meanDurationMs:rules.reduce((n,r)=>n+r.durationMs,0)/rules.length},cases:rules},results,
    independentReview:false,promotionEligible:false,
    limitation:'Exploratory single-pass comparison on known correlated cases with single-author labels. Path agreement is not semantic evidence accuracy. No fallback credit, financial actions, production promotion or operator ROI claim.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {values}=parseArgs({options:{models:{type:'string'},'rules-only':{type:'boolean'}}});
  const models=values.models?.split(',').filter(Boolean)??[];
  if((values['rules-only']&&models.length)||(!values['rules-only']&&!models.length))throw new Error('Specify --rules-only or --models qwen2.5:1.5b,qwen2.5:3b');
  console.log(JSON.stringify(await evaluateBatchInvestigation(models,fetch,(message)=>console.error(message)),null,2));
}
