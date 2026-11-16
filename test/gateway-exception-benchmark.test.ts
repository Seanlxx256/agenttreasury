import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractEvidenceContextRules } from '../src/gateway-evidence-context-rules.js';
import { extractEvidenceRules } from '../src/gateway-evidence-extraction.js';
import { gatewayEvidenceCases } from '../src/gateway-evidence-cases.js';
import { gatewayEvidenceTestCases } from '../src/gateway-evidence-test-cases.js';
import { assertFrozenHashes, evaluateExceptionCases, loadFrozenExceptionBenchmark } from '../src/evaluate-gateway-exceptions.js';
import { exceptionCandidate, scoreException, summarizeExceptions, validateExceptionCases, type ExceptionCase } from '../src/gateway-exception-scoring.js';

const sample:ExceptionCase={id:'unit-1',text:'Signature invalid. RPC timeout.',stratum:'unit',expected:['invalid-signature','rpc-unavailable'],
  support:[{signal:'invalid-signature',start:0,end:17},{signal:'rpc-unavailable',start:19,end:30}],rationale:'Unit fixture only.'};
const negative:ExceptionCase={id:'unit-2',text:'No evidence of insufficient funds was found.',stratum:'negative',expected:[],support:[],rationale:'Denied condition.'};

test('context control suppresses scoped statements and keeps current faults after contrast',()=>{
  for (const text of ['No evidence of insufficient funds.', 'Previous incident: signature invalid.',
    'If the authorization expired, retry would fail.', 'RPC timeout was resolved.', 'Documentation example: nonce already used.']) {
    assert.ok(extractEvidenceRules(text).length>0);assert.deepEqual(extractEvidenceContextRules(text),[]);
  }
  assert.deepEqual(extractEvidenceContextRules('RPC timeout was resolved, but signature invalid.').map((r)=>r.signal),['invalid-signature']);
  assert.deepEqual(extractEvidenceContextRules('The account cannot cover this transfer.').map((r)=>r.signal),['insufficient-funds']);
});

test('a verbatim quote can still be an unsupported diagnosis',()=>{
  const result=scoreException(negative,[{signal:'insufficient-funds',quote:'insufficient funds'}]);
  assert.equal(result.verbatimQuotes,1);assert.equal(result.supportedQuotes,0);
  assert.equal(result.falsePositives,1);assert.equal(result.exact,false);
  const summary=summarizeExceptions([result]);assert.equal(summary.negativeFalsePositiveRate,1);
});

test('duplicate outputs cannot inflate label or annotated-span coverage',()=>{
  const result=scoreException(sample,[{signal:'invalid-signature',quote:'Signature invalid'},
    {signal:'invalid-signature',quote:'Signature invalid'},{signal:'rpc-unavailable',quote:'RPC timeout'}]);
  assert.equal(result.truePositives,2);assert.equal(result.quoteCount,2);assert.equal(result.supportedSignals,2);
  const summary=summarizeExceptions([result]);assert.equal(summary.recall,1);assert.equal(summary.annotatedSpanCoverage,1);
});

test('unknown is abstention; failures receive no correct-negative credit; incomplete quotes get no span credit',()=>{
  const abstain=scoreException(negative,[{signal:'unknown-error',quote:negative.text}]);
  assert.equal(abstain.exact,true);assert.equal(abstain.abstained,true);
  const failed=scoreException(negative,[],'unavailable');assert.equal(failed.exact,false);assert.equal(failed.abstained,false);
  const summary=summarizeExceptions([abstain,failed]);
  assert.equal(summary.negativeFalsePositiveRate,0);assert.equal(summary.negativeSuccessRate,0.5);assert.equal(summary.unavailable,1);
  assert.equal(summary.tokens.input,null);
  assert.equal(scoreException(sample,[{signal:'invalid-signature',quote:'Signature'}]).supportedSignals,0);
  const mixed=scoreException(sample,[{signal:'unknown-error',quote:sample.text},{signal:'rpc-unavailable',quote:'RPC timeout'}]);
  assert.equal(mixed.mixedAbstention,true);
});

test('frozen corpus is disjoint, balanced and bound to exact sources and compiled runtime',async()=>{
  const {cases,manifest}=await loadFrozenExceptionBenchmark();
  assert.equal(cases.length,36);assert.equal(cases.filter((row)=>row.expected.length===0).length,18);
  assert.equal(cases.reduce((n,row)=>n+row.expected.length,0),20);
  const previous=new Set([...gatewayEvidenceCases,...gatewayEvidenceTestCases].map((row)=>row.text.toLowerCase().trim()));
  assert.ok(cases.every((row)=>!previous.has(row.text.toLowerCase().trim())));
  assert.match(manifest.provenance.annotation,/no independent human/);
  assertFrozenHashes({file:'a'},{file:'a'});
  for (const candidate of [{file:'b'},{file:'a',extra:'a'},{}] as Record<string,string>[]) assert.throws(()=>assertFrozenHashes({file:'a'},candidate),/drift/);
  assert.throws(()=>validateExceptionCases([{id:'x',text:'a'}],[{...sample,id:'x'}]),/Invalid label/);
});

test('the model sees source text only; no labels, rationales or strata leak; usage is measured separately',async()=>{
  const before=await readFile(new URL('../../src/gateway-evidence-extraction.ts',import.meta.url),'utf8');
  const report=await evaluateExceptionCases([sample],['mock-model'],async(_url,init)=>{
    const request=JSON.parse(String(init?.body));
    assert.equal(request.messages[1].content,sample.text);
    assert.ok(!JSON.stringify(request).includes(sample.rationale));assert.ok(!JSON.stringify(request).includes(sample.id));
    return Response.json({prompt_eval_count:20,eval_count:10,message:{content:JSON.stringify({signals:[
      {signal:'invalid-signature',quote:'Signature invalid'},{signal:'rpc-unavailable',quote:'RPC timeout'},
    ]})}});
  });
  assert.equal(report.models[0]!.summary.tokens.input,20);assert.equal(report.models[0]!.summary.tokens.output,10);
  assert.equal(report.models[0]!.summary.recall,1);assert.equal(report.ruleFallback,false);
  assert.equal(await readFile(new URL('../../src/gateway-evidence-extraction.ts',import.meta.url),'utf8'),before);
});

test('failed model calls are not replaced by rule successes or eligible for promotion',async()=>{
  const report=await evaluateExceptionCases([sample,negative],['failed-model'],async()=>{throw new Error('offline');});
  const model=report.models[0]!;
  assert.equal(model.summary.unavailable,2);assert.equal(model.summary.exactCaseRate,0);
  assert.equal(model.summary.recall,0);assert.equal(model.candidateGate.candidate,false);
  assert.equal(model.candidateGate.productionApproval,false);
  assert.equal(exceptionCandidate(model.summary,report.baselines.context.summary).checks.availability,false);
});

test('independent review export contains inputs and empty annotations, not gold labels or model results',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../scripts/export-exception-review.mjs',import.meta.url))]);
  const result=JSON.parse(stdout);assert.equal(result.reviewStatus,'unreviewed');assert.equal(result.reviewer,null);
  assert.equal(result.cases.length,36);assert.match(result.manifestHash,/^[0-9a-f]{64}$/);
  for (const row of result.cases) {
    assert.deepEqual(Object.keys(row).sort(),['confidence','id','rationale','signals','support','text']);
    assert.equal(row.signals,null);assert.equal(row.support,null);assert.equal(row.rationale,null);
  }
});
