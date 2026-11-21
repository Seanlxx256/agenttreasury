import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertFrozenSources, withFrozenDependencies } from './frozen-dependencies.js';
import { batchEvalOptions, batchEvalPrompt, citationCatalog, decideBatchRules, pointerValue, rawBatchCheck,
  runBatchModel, validBatchDecision, type BatchEvalInput, type BatchDecision } from '../src/batch-investigation-eval.js';
import { batchProtocolFiles, protocolRoot, evaluateBatchInvestigation, reviewRoot, scoreBatchDecision, summarizeBatchScores, verifyBatchProtocol } from '../src/evaluate-batch-investigation.js';

const cases:Array<{id:string;input:BatchEvalInput}>=JSON.parse(await readFile(new URL('inputs.json',reviewRoot),'utf8'));
const missing=cases[1]!.input;
const response=(value:unknown)=>Response.json({message:{content:JSON.stringify(value)},prompt_eval_count:120,eval_count:20,done_reason:'stop'});

test('frozen data, compiled dependency closure, runtime and rules reproduce the exploratory baseline',async()=>{
  const manifest=JSON.parse(await readFile(new URL('manifest.json',protocolRoot),'utf8'));
  await assertFrozenSources(await batchProtocolFiles(),manifest.files);
  assert.ok(manifest.files['src/gateway-batch-evidence.ts']);assert.ok(manifest.files['dist/src/gateway-batch-linkage.js']);
  // Ordinary CI may use Node 22. Test pure rules/scoring there, while ensuring
  // actual frozen runs refuse a runtime different from the recorded one.
  if(manifest.node===process.version) {
    await assert.rejects(verifyBatchProtocol(), /Frozen evaluation files changed/);
    const result=await withFrozenDependencies(async (root) => {
      const historical = await import(new URL('dist/src/evaluate-batch-investigation.js', root).href);
      await historical.verifyBatchProtocol();
      return historical.evaluateBatchInvestigation();
    });
    assert.equal(result.rules.summary.correct,12);assert.equal(result.rules.summary.strictSuccesses,12);
    assert.equal(result.promotionEligible,false);assert.equal(result.independentReview,false);assert.equal(result.results.length,0);
  } else {
    await assert.rejects(verifyBatchProtocol(),/Node runtime differs/);
    await assert.rejects(evaluateBatchInvestigation(),/Node runtime differs/);
  }
  const labels=JSON.parse(await readFile(new URL('labels.json',reviewRoot),'utf8'));
  const scores=cases.map((sample)=>scoreBatchDecision(decideBatchRules(sample.input),labels.find((l:{id:string})=>l.id===sample.id)));
  assert.equal(summarizeBatchScores(scores).strictSuccesses,12);
  for(const c of cases)assert.ok(validBatchDecision(decideBatchRules(c.input),c.input));
});

test('output gate rejects fabricated paths, duplicates, unbounded reads and financial instructions',()=>{
  const good:BatchDecision={status:'incomplete',checks:['read-original-authorization'],citations:['/purchase/authorization']};
  assert.ok(validBatchDecision(good,missing));
  for(const candidate of [
    {...good,citations:['/purchase/authorization/nonce']}, // Parent is null; child does not exist.
    {...good,citations:['/__proto__']},{...good,citations:['/purchase/authorization','/purchase/authorization']},
    {...good,checks:['refund-now']},{...good,execute:'refund'},
    {...good,checks:['read-original-authorization','read-original-authorization']},
    {...good,checks:['read-original-authorization','read-gateway-status','read-chain-receipt','read-local-journal']},
  ])assert.equal(validBatchDecision(candidate,missing),false);
  assert.equal(pointerValue(missing,'/purchase/authorization'),null);
  assert.equal(pointerValue(missing,'/purchase/authorization/nonce'),undefined);
  assert.equal(pointerValue({},'/constructor'),undefined);
  assert.ok(citationCatalog(missing).includes('/purchase/authorization'));
});

test('scoring deduplicates matches, distinguishes exact annotations from existence and counts parsed unsafe claims',()=>{
  const label={id:'fixture',expectedStatus:'incomplete' as const,requiredChecks:['read-original-authorization'],evidencePaths:['/purchase/authorization']};
  const good:BatchDecision={status:'incomplete',checks:['read-original-authorization'],citations:['/purchase/authorization']};
  assert.equal(scoreBatchDecision(good,label).strictSuccess,true);
  const extra=scoreBatchDecision({...good,citations:[...good.citations,'/journal']},label);
  assert.equal(extra.annotatedPathMatches,1);assert.equal(extra.citations,2);assert.equal(extra.strictSuccess,false);
  const duplicate=scoreBatchDecision({...good,checks:[...good.checks,...good.checks],citations:[...good.citations,...good.citations]},label);
  assert.equal(duplicate.requiredCheckMatches,1);assert.equal(duplicate.annotatedPathMatches,1);
  const failed=scoreBatchDecision(null,label,'corroborated');
  assert.equal(failed.falseCorroboration,true);assert.equal(failed.statusCorrect,false);
  const summary=summarizeBatchScores([scoreBatchDecision(good,label),failed]);
  assert.equal(summary.statusAccuracy,0.5);assert.equal(summary.requiredCheckRecall,0.5);
  assert.equal(summary.annotatedPathRecall,0.5);assert.equal(summary.falseCorroborations,1);
});

test('model receives evidence and shared raw validator results, never labels, IDs or provenance answers',async()=>{
  let calls=0;
  const result=await runBatchModel(missing,'fixture',async(url,init)=>{
    calls++;assert.equal(url,'http://127.0.0.1:11434/api/chat');
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body.options,batchEvalOptions);assert.equal(body.messages[0].content,batchEvalPrompt);
    const payload=JSON.parse(body.messages[1].content);
    assert.deepEqual(payload.input,missing);assert.deepEqual(payload.rawBatchCheck,rawBatchCheck(missing));
    for(const key of ['expectedStatus','requiredChecks','rationale','provenance','case-02'])assert.ok(!String(init?.body).includes(key));
    return response({status:'incomplete',checks:['read-original-authorization'],citations:['/purchase/authorization']});
  });
  assert.equal(calls,1);assert.equal(result.status,'ready');assert.equal(result.promptTokens,120);assert.equal(result.outputTokens,20);
});

test('model errors and rejected claims never acquire rule-fallback credit',async()=>{
  const rejected=await runBatchModel(missing,'fixture',async()=>response({status:'corroborated',checks:['refund-now'],citations:['/journal']}));
  assert.equal(rejected.status,'rejected');assert.equal(rejected.decision,null);assert.equal(rejected.candidateStatus,'corroborated');
  const unavailable=await runBatchModel(missing,'fixture',async()=>{throw new Error('offline');});
  assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.decision,null);assert.equal(unavailable.promptTokens,null);
  assert.equal(rawBatchCheck(cases[7]!.input).status,'conflict');
});

test('a changed model digest stops the run before inference',async()=>{
  const manifest=JSON.parse(await readFile(new URL('manifest.json',protocolRoot),'utf8'));let calls=0;
  await withFrozenDependencies(async (root) => {
  const historical = await import(new URL('dist/src/evaluate-batch-investigation.js', root).href) as typeof import('../src/evaluate-batch-investigation.js');
  await assert.rejects(historical.evaluateBatchInvestigation([manifest.models[0].name],async(url)=>{
    calls++;assert.equal(url,'http://127.0.0.1:11434/api/tags');
    return Response.json({models:[{name:manifest.models[0].name,digest:'different'}]});
  }),manifest.node===process.version?/digest differs/:/Node runtime differs/);
  assert.equal(calls,manifest.node===process.version?1:0);
  });
});
