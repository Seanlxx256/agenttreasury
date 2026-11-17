import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dialogueCases } from '../src/investigation-dialogue-cases.js';
import { callDialogueModel, decideDialogueRules, dialogueDecisionError, dialogueTools, ruleDialoguePolicy, runDialogue,
  type DialogueDecision, type DialoguePolicy, type DialogueReply, type DialogueView } from '../src/investigation-dialogue.js';
import { evaluateDialoguePlan, planDialogueEvaluation, scoreDialogue, summarizeDialogues } from '../src/evaluate-investigation-dialogue.js';
import { devSourceHashes } from '../src/evaluate-batch-investigation-dev.js';

const cases = dialogueCases();
const reply = (candidate: unknown): DialogueReply => ({ status: 'ready', candidate, rawOutput: JSON.stringify(candidate), reason: null,
  durationMs: 1, promptTokens: 10, outputTokens: 10 });
const initialView = (): DialogueView => ({ initial: structuredClone(cases[0]!.initial), records: [], availableTools: [...dialogueTools],
  remainingReads: 3, permittedCitations: ['seed'] });
const finish = (conclusion: string, citations = ['seed']) => ({ action: 'finish', conclusion, citations });

test('new paired cases branch on hidden reads and the adaptive rule policy resolves all eight without oracle access', async () => {
  for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7]]) {
    assert.deepEqual(cases[a!]!.initial, cases[b!]!.initial);
    assert.notDeepEqual(cases[a!]!.hidden, cases[b!]!.hidden);
  }
  const plan = await planDialogueEvaluation(null);
  const result = await evaluateDialoguePlan(plan);
  assert.equal(result.groups[0]!.summary.supportedSuccesses, 8);
  assert.equal(result.groups[0]!.summary.reads, 12);
  assert.equal(result.groups[0]!.summary.usefulReads, 11); // One hindsight-unneeded read precedes the missing journal field.
  assert.equal(result.groups[0]!.cases[4]!.run.records.length, 2);
  assert.equal(result.groups[0]!.cases[5]!.run.records.length, 1);
  assert.equal(result.promotionEligible, false);
  plan.cases[0]!.hidden['read-local-journal'].fields.amount = 'modified';
  await assert.rejects(evaluateDialoguePlan(plan), /plan changed/);
});

test('model receives only the current view, never hidden results, labels, IDs or future citations', async () => {
  const row = cases[1]!, seen: DialogueView[] = [];
  const run = await runDialogue(row.initial, async (tool) => structuredClone(row.hidden[tool]), (view) => callDialogueModel(view, 'fixture', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(init?.body)), received: DialogueView = JSON.parse(body.messages[1].content);
    seen.push(received); assert.deepEqual(received, view);
    for (const secret of ['"hidden"', '"label"', '"witnesses"', '"rationale"', 'dialogue-02']) assert.ok(!String(init?.body).includes(secret));
    if (!view.records.length) assert.ok(!String(init?.body).includes('2400'));
    const decision = decideDialogueRules(received);
    return Response.json({ message: { content: JSON.stringify(decision) }, prompt_eval_count: 100, eval_count: 20 });
  }));
  assert.deepEqual(seen.map((view) => view.records.length), [0, 1, 2]);
  assert.equal(seen[1]!.records[0]!.tool, 'read-gateway-status');
  assert.equal(seen[2]!.records[1]!.result.fields.amount, '2400');
  assert.equal(run.final?.conclusion, 'conflict'); assert.equal(scoreDialogue(run, row.label).supportedSuccess, true);
});

test('unread citations, repeated reads, arbitrary arguments and financial actions stop before a tool executes', async () => {
  const invalid = [
    { action: 'refund', conclusion: 'none', citations: ['seed'] },
    { action: 'read-gateway-status', conclusion: 'none', citations: ['record-1'] },
    { action: 'read-gateway-status', conclusion: 'none', citations: ['seed'], url: 'https://attacker.invalid' },
    { action: 'read-gateway-status', conclusion: 'none', citations: ['seed'], requestId: 'another-task' },
    { action: 'read-gateway-status', conclusion: 'corroborated', citations: ['seed'] },
    { action: 'finish', conclusion: 'none', citations: ['seed'] },
  ];
  for (const candidate of invalid) {
    let reads = 0;
    const result = await runDialogue(cases[0]!.initial, async () => { reads++; return cases[0]!.hidden['read-gateway-status']; }, async () => reply(candidate));
    assert.equal(result.status, 'rejected'); assert.equal(reads, 0);
  }
  let reads = 0;
  const repeated = await runDialogue(cases[0]!.initial, async () => { reads++; return cases[0]!.hidden['read-gateway-status']; },
    async () => reply({ action: 'read-gateway-status', conclusion: 'none', citations: ['seed'] }));
  assert.equal(repeated.status, 'rejected'); assert.equal(reads, 1);
});

test('three-read budget and snapshot isolation hold even if a policy mutates its supplied view', async () => {
  let reads = 0, turns = 0;
  const result = await runDialogue(cases[0]!.initial, async (tool) => { reads++; return structuredClone(cases[0]!.hidden[tool]); }, async (view) => {
    turns++;
    const action = view.availableTools[0] ?? 'read-gateway-status';
    view.initial.revision = 'forged'; view.permittedCitations.push('fake'); view.records.length = 0;
    return reply({ action, conclusion: 'none', citations: ['seed'] });
  });
  assert.equal(reads, 3); assert.equal(turns, 4); assert.equal(result.status, 'rejected');
  assert.equal(result.turns[3]!.view.availableTools.length, 0);
  assert.equal(result.turns[3]!.view.initial.revision, 'v4');
  assert.equal(result.records.length, 3); assert.equal(result.financialAuthority, false);
});

test('partial, stale, failed and instruction-bearing responses do not become corroboration in the rule baseline', async () => {
  for (const index of [3, 5, 6, 7]) {
    const row = cases[index]!;
    const result = await runDialogue(row.initial, async (tool) => structuredClone(row.hidden[tool]), ruleDialoguePolicy);
    assert.equal(result.final?.conclusion, 'incomplete');
  }
  const stale = await runDialogue(cases[2]!.initial, async () => ({ ...structuredClone(cases[2]!.hidden['read-original-authorization']), revision: 'v3' }), ruleDialoguePolicy);
  assert.equal(stale.final?.conclusion, 'incomplete'); assert.ok(stale.final?.citations.includes('seed'));
  const failed = await runDialogue(cases[0]!.initial, async () => { throw new Error('offline'); }, ruleDialoguePolicy);
  assert.equal(failed.final?.conclusion, 'incomplete'); assert.equal(failed.records[0]!.result.status, 'unavailable');
  const throwingPolicy = await runDialogue(cases[0]!.initial, async (tool) => cases[0]!.hidden[tool], async () => { throw new Error('planner down'); });
  assert.equal(throwingPolicy.status, 'unavailable'); assert.equal(throwingPolicy.turns[0]!.reply.reason, 'policy-error');
});

test('both valid read orders earn support; guessing a correct answer before reading earns no supported success', async () => {
  const row = cases[0]!;
  const reversed: DialoguePolicy = async (view) => reply(view.records.length === 0
    ? { action: 'read-local-journal', conclusion: 'none', citations: ['seed'] }
    : view.records.length === 1 ? { action: 'read-gateway-status', conclusion: 'none', citations: ['record-1'] }
      : finish('corroborated', ['seed', 'record-1', 'record-2']));
  const result = await runDialogue(row.initial, async (tool) => structuredClone(row.hidden[tool]), reversed);
  assert.equal(scoreDialogue(result, row.label).supportedSuccess, true);
  const guess = await runDialogue(row.initial, async (tool) => row.hidden[tool], async () => reply(finish('corroborated')));
  const score = scoreDialogue(guess, row.label);
  assert.equal(score.correct, true); assert.equal(score.supportedSuccess, false); assert.equal(score.prematureFinish, true);
  assert.equal(score.unsupportedCorroboration, true); assert.equal(score.requiredEvidenceCoverage, 0);
  assert.equal(summarizeDialogues([{ run: guess, score }]).usefulReadRate, null);
  const rejected = await runDialogue(cases[1]!.initial, async (tool) => cases[1]!.hidden[tool], async () => reply(finish('corroborated', ['unread'])));
  assert.equal(scoreDialogue(rejected, cases[1]!.label).falseCorroboration, true);
});

test('model transport preserves raw rejected text, validates schema and bounds response size', async () => {
  const view = initialView();
  const call = (request: typeof fetch) => callDialogueModel(view, 'fixture', request);
  const badJson = await call(async () => Response.json({ message: { content: 'broken JSON' } }));
  assert.equal(badJson.reason, 'invalid-output-json'); assert.equal(badJson.rawOutput, 'broken JSON');
  const badAction = await call(async () => Response.json({ message: { content: JSON.stringify({ action: 'pay', conclusion: 'none', citations: ['seed'] }) } }));
  assert.equal(badAction.reason, 'action-not-available'); assert.ok(badAction.candidate);
  const timeout = await call(async () => { throw new DOMException('timeout', 'TimeoutError'); });
  assert.equal(timeout.reason, 'timeout'); assert.equal(timeout.status, 'unavailable');
  const transport = await call(async () => { throw new TypeError('offline'); }); assert.equal(transport.reason, 'transport-error');
  const http = await call(async () => new Response('secret error', { status: 503 })); assert.equal(http.reason, 'http-503'); assert.equal(http.rawOutput, null);
  assert.equal(http.transport?.httpStatus, 503);
  const huge = await call(async () => new Response('x'.repeat(65537))); assert.equal(huge.reason, 'response-too-large');
  const content = await call(async () => Response.json({ message: { content: 'x'.repeat(8001) } }));
  assert.equal(content.reason, 'content-too-large-truncated'); assert.equal(content.rawOutput?.length, 8000);
  assert.equal(content.transport?.rawOutputTruncated, true);
  const decision: DialogueDecision = { action: 'read-gateway-status', conclusion: 'none', citations: ['seed', 'seed'] };
  assert.equal(dialogueDecisionError(decision, view), 'invalid-citation-count');
});

test('model identity is captured before inference and the previous Stage 8 implementation remains unchanged', async () => {
  const plan = await planDialogueEvaluation('qwen2.5:3b', async (url) => String(url).endsWith('/api/tags')
    ? Response.json({ models: [{ name: 'qwen2.5:3b', digest: 'a'.repeat(64), details: {} }] }) : Response.json({ version: 'fixture' }));
  assert.equal(plan.model?.digest, 'a'.repeat(64)); assert.ok(plan.files['src/investigation-dialogue.ts']);
  await assert.rejects(planDialogueEvaluation('qwen2.5:7b'), /protocol uses/);
  await assert.rejects(planDialogueEvaluation('qwen2.5:3b', async () => Response.json({ models: [] })), /Missing model digest/);
  const previous = JSON.parse(await readFile(new URL('../../docs/evidence/stage-8-batch-development.json.plan.json', import.meta.url), 'utf8'));
  assert.deepEqual(await devSourceHashes(), previous.files);
});
