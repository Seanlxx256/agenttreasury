import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { extractEvidenceRules, extractEvidenceWithModel } from './gateway-evidence-extraction.js';
import { extractEvidenceContextRules } from './gateway-evidence-context-rules.js';
import { exceptionCandidate, exceptionGates, scoreException, summarizeExceptions, validateExceptionCases,
  type ExceptionCase, type ExceptionScore } from './gateway-exception-scoring.js';
import { resolveTriageModelProfile } from './gateway-triage-models.js';

export const benchmarkRoot=new URL('../../benchmarks/evidence-exceptions-v2/',import.meta.url);
const root=new URL('../../',import.meta.url);
export const frozenBenchmarkPaths=[
  'benchmarks/evidence-exceptions-v2/inputs.json','benchmarks/evidence-exceptions-v2/labels.json','package-lock.json',
  ...['gateway-evidence-extraction','gateway-evidence-context-rules','gateway-triage-models','gateway-exception-scoring','evaluate-gateway-exceptions']
    .flatMap((name)=>[`src/${name}.ts`,`dist/src/${name}.js`]),
];
export const sha256=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');

export async function frozenFileHashes() {
  return Object.fromEntries(await Promise.all(frozenBenchmarkPaths.map(async(path)=>[path,sha256(await readFile(new URL(path,root)))])));
}
export function assertFrozenHashes(current:Record<string,string>,frozen:Record<string,string>) {
  if (JSON.stringify(Object.keys(current).sort())!==JSON.stringify(Object.keys(frozen).sort()) ||
      Object.entries(current).some(([path,digest])=>frozen[path]!==digest)) {
    throw new Error('Frozen benchmark drift: use a new dataset/protocol version instead of rewriting the manifest');
  }
}
export async function loadFrozenExceptionBenchmark() {
  const bytes=await readFile(new URL('manifest.json',benchmarkRoot));
  const manifest=JSON.parse(bytes.toString());
  const current=await frozenFileHashes();
  if (manifest.version!==1) throw new Error('Unknown frozen benchmark version');
  assertFrozenHashes(current,manifest.files ?? {});
  const cases=validateExceptionCases(JSON.parse(await readFile(new URL('inputs.json',benchmarkRoot),'utf8')),
    JSON.parse(await readFile(new URL('labels.json',benchmarkRoot),'utf8')));
  if (cases.length!==manifest.cases) throw new Error('Frozen case count mismatch');
  return {cases,manifest,manifestHash:sha256(bytes)};
}

export async function evaluateExceptionCases(samples:ExceptionCase[],models:string[],request:typeof fetch=fetch,
  progress:(message:string)=>void=()=>{}) {
  const reportRows=(rows:ExceptionScore[])=>({summary:summarizeExceptions(rows),
    byStratum:Object.fromEntries([...new Set(rows.map((row)=>row.stratum))].map((group)=>[group,summarizeExceptions(rows.filter((row)=>row.stratum===group))])),cases:rows});
  const baseline=(extract:typeof extractEvidenceRules)=>reportRows(samples.map((sample)=>{
    const start=performance.now();const result=extract(sample.text);return scoreException(sample,result,'ready',performance.now()-start);
  }));
  const baselines={keyword:baseline(extractEvidenceRules),context:baseline(extractEvidenceContextRules)};
  const results=[];
  for (const model of models) {
    const rows:ExceptionScore[]=[];
    for (const [index,sample] of samples.entries()) {
      progress(`${model}: ${index+1}/${samples.length}`);
      let inputTokens:number|null=null;let outputTokens:number|null=null;
      const metered:typeof fetch=async(url,init)=>{
        const response=await request(url,init);
        try {
          const metadata=await response.clone().json();
          if (Number.isSafeInteger(metadata.prompt_eval_count) && metadata.prompt_eval_count>=0) inputTokens=metadata.prompt_eval_count;
          if (Number.isSafeInteger(metadata.eval_count) && metadata.eval_count>=0) outputTokens=metadata.eval_count;
        } catch { /* Missing usage is unknown, never zero. */ }
        return response;
      };
      const start=performance.now();
      const result=await extractEvidenceWithModel(sample.text,model,metered);
      rows.push(scoreException(sample,result.signals,result.status==='disabled' ? 'unavailable' : result.status,
        performance.now()-start,{input:inputTokens,output:outputTokens}));
    }
    const report=reportRows(rows);
    const repaired=rows.filter((row,index)=>row.exact && !baselines.context.cases[index]!.exact).map((row)=>row.id);
    const regressed=rows.filter((row,index)=>!row.exact && baselines.context.cases[index]!.exact).map((row)=>row.id);
    results.push({model,options:resolveTriageModelProfile(model).options,...report,pairedWithContext:{repaired,regressed},
      candidateGate:exceptionCandidate(report.summary,baselines.context.summary)});
  }
  return {dataset:'evidence-exceptions-v2',task:'currently asserted concrete failure signals',
    unknownErrorIsAbstention:true,ruleFallback:false,gates:exceptionGates,baselines,models:results};
}

async function main() {
  const {values}=parseArgs({options:{models:{type:'string'},'rules-only':{type:'boolean'}}});
  if (Boolean(values.models)===Boolean(values['rules-only'])) throw new Error('Choose --rules-only or --models MODEL[,MODEL]');
  const models=[...new Set((values.models ?? '').split(',').map((s)=>s.trim()).filter(Boolean))];
  if (!values['rules-only'] && !models.length) throw new Error('Specify a model');
  const benchmark=await loadFrozenExceptionBenchmark();
  let runtime:unknown=null;
  if (models.length) {
    const [tags,version]=await Promise.all([
      fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(5000),redirect:'error'}),
      fetch('http://127.0.0.1:11434/api/version',{signal:AbortSignal.timeout(5000),redirect:'error'}),
    ]);
    if (!tags.ok || !version.ok) throw new Error('Local Ollama metadata unavailable');
    const inventory=await tags.json();
    const installed=models.map((name)=>{
      const entry=inventory.models?.find((m:{name:string})=>m.name===name);
      if (!entry) throw new Error(`Model is not installed: ${name}; this benchmark never downloads models`);
      return {name,digest:entry.digest};
    });
    runtime={version:await version.json(),models:installed};
  }
  const startedAt=new Date().toISOString();
  const report=await evaluateExceptionCases(benchmark.cases,models,fetch,(message)=>console.error(message));
  // Reject edits during a run as well as edits before the run.
  const after=await loadFrozenExceptionBenchmark();
  if (after.manifestHash!==benchmark.manifestHash) throw new Error('Benchmark manifest changed during evaluation');
  console.log(JSON.stringify({...report,startedAt,finishedAt:new Date().toISOString(),runtime,
    manifestHash:benchmark.manifestHash,provenance:benchmark.manifest.provenance},null,2));
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
