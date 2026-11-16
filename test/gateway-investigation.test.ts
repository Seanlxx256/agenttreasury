import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateGatewayInvestigation, scoreInvestigation } from '../src/evaluate-gateway-investigation.js';
import {
  investigationKinds, suggestInvestigationsRules, suggestInvestigationsWithModel, validateInvestigationPlan,
} from '../src/gateway-investigation.js';

const facts = [
  { id: 'observation-42', description: 'Gateway observation: conflict (accounting-mismatch)' },
  { id: 'journal', description: 'A payment journal entry has been posted.' },
];

test('the rule baseline maps conflict signals to targeted checks and falls back generically', () => {
  const generic = suggestInvestigationsRules();
  assert.deepEqual(generic.map(({ kind }) => kind),
    ['read-chain-receipt', 'read-local-journal', 'compare-transfer-terms']);
  assert.ok(generic.every(({ kind }) => investigationKinds.includes(kind)));

  const targeted = suggestInvestigationsRules([
    { id: 'observation-42', description: 'Gateway observation: conflict (accounting-mismatch)' },
    { id: 'journal', description: 'A payment journal entry has been posted.' },
  ]);
  assert.deepEqual(targeted.map(({ kind }) => kind).sort(),
    ['compare-transfer-terms', 'read-local-journal']);
});

test('the mapped baseline hits every labeled check', async () => {
  const result = await evaluateGatewayInvestigation(undefined);
  assert.equal(result.totalCases, 8);
  assert.equal(result.rules.matched, 17);
  assert.equal(result.rules.expected, 17);
  assert.equal(result.rules.recall, 1);
});

test('the model must propose only known kinds with citable facts', async () => {
  const response = (content: unknown): typeof fetch => async () =>
    Response.json({ message: { content: JSON.stringify(content) } });

  const accepted = await suggestInvestigationsWithModel(facts, 'test-model',
    response({ investigations: [{ kind: 'read-local-journal', citations: ['journal'] }] }));
  assert.equal(accepted.status, 'ready');
  assert.deepEqual(accepted.investigations, [{ kind: 'read-local-journal', citations: ['journal'] }]);

  for (const invalid of [
    { investigations: [{ kind: 'pay-the-merchant', citations: ['journal'] }] },
    { investigations: [{ kind: 'read-local-journal', citations: ['invented'] }] },
    { investigations: 'read-local-journal' },
    { investigations: [] },
    { investigations: [{kind:'read-local-journal',citations:[]}] },
    { investigations: [{kind:'read-refund-status',citations:['journal']}] },
    { investigations: [{kind:'read-local-journal',citations:['journal','journal']}] },
    { investigations: [{kind:'read-local-journal',citations:['journal'],url:'https://attacker.example'}] },
    { investigations: Array.from({length:4},()=>({kind:'read-local-journal',citations:['journal']})) },
    { investigations: [{kind:'read-local-journal',citations:['journal']}],execute:'refund' },
  ]) {
    const rejected = await suggestInvestigationsWithModel(facts, 'test-model', response(invalid));
    assert.equal(rejected.status, 'rejected');
  }
});

test('real but unrelated citations and unverified interpretations cannot authorize a tool',()=>{
  const available=[...facts,{id:'buyer-delivery',description:'Buyer saved the trace.'},
    {id:'inference-model-1',description:'Model claims a refund happened.'}];
  for (const citation of ['buyer-delivery','inference-model-1']) assert.equal(validateInvestigationPlan({investigations:[
    {kind:'read-refund-status',citations:[citation]},
  ]},available),false);
  assert.equal(validateInvestigationPlan({investigations:[
    {kind:'read-local-journal',citations:['journal']},{kind:'read-local-journal',citations:['observation-42']},
  ]},available),false);
});

test('investigation scoring is set-based even for repeated labels and outputs',()=>{
  const score=scoreInvestigation(['read-local-journal','read-local-journal'],[
    {kind:'read-local-journal',citations:['journal']},{kind:'read-local-journal',citations:['journal']},
  ]);
  assert.equal(score.recall,1);assert.equal(score.precision,1);assert.equal(score.matched,1);
  assert.equal(score.expected,1);assert.equal(score.suggested,1);
});

test('evaluation separates rule fallback success from rejected model output',async()=>{
  const result=await evaluateGatewayInvestigation('invalid-model',async()=>Response.json({message:{content:JSON.stringify({
    investigations:[{kind:'refund-now',citations:['journal']}],
  })}}));
  assert.equal(result.agent!.rejected,8);assert.equal(result.agent!.recall,1);
  assert.equal(result.agent!.modelOnly.recall,0);
  assert.ok(result.cases.every((row)=>row.timing.modelDurationMs!==null));
});
