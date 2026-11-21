import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { dialogueCases } from '../src/investigation-dialogue-cases.js';
import { decideDialogueRules, dialogueTools, runDialogue, type DialogueView } from '../src/investigation-dialogue.js';
import { callDialogueModelV2, decodeDialogueV2, dialogueSchemaV2 } from '../src/investigation-dialogue-v2.js';
import { dialogueSourceHashes, scoreDialogue } from '../src/evaluate-investigation-dialogue.js';
import { evaluateDialogueV2, planDialogueV2 } from '../src/evaluate-investigation-dialogue-v2.js';
import { assertFrozenSources } from './frozen-dependencies.js';

const view = (): DialogueView => ({ initial: dialogueCases()[0]!.initial, records: [], availableTools: [...dialogueTools], remainingReads: 3, permittedCitations: ['seed'] });

test('V2 read and finish shapes are disjoint; malformed read conclusions are rejected rather than stripped', () => {
  const current = view(), schema = dialogueSchemaV2(current);
  assert.ok('anyOf' in schema); assert.equal(schema.anyOf?.length, 2);
  const read = { action: 'read-gateway-status', citations: ['seed'] };
  assert.deepEqual(decodeDialogueV2(read, current), { reason: null, candidate: { ...read, conclusion: 'none' } });
  assert.equal(decodeDialogueV2({ ...read, conclusion: 'corroborated' }, current).reason, 'read-shape-requires-action-and-citations-only');
  assert.equal(decodeDialogueV2({ ...read, url: 'https://attacker.invalid' }, current).reason, 'read-shape-requires-action-and-citations-only');
  assert.equal(decodeDialogueV2({ ...read, citations: ['unread'] }, current).reason, 'citation-not-visible');
  assert.equal(decodeDialogueV2({ action: 'finish', citations: ['seed'] }, current).reason, 'unexpected-or-missing-fields');
  const last = dialogueSchemaV2({ ...current, availableTools: [], remainingReads: 0 });
  assert.ok(!('anyOf' in last)); assert.deepEqual(last.properties.action.enum, ['finish']);
});

test('V2 preserves actual wire text while the same bounded runner performs multiple reads', async () => {
  const sample = dialogueCases()[1]!;
  const run = await runDialogue(sample.initial, async (tool) => structuredClone(sample.hidden[tool]), (current) => callDialogueModelV2(current, 'fixture', async (_, init) => {
    const body = JSON.parse(String(init?.body)); assert.deepEqual(body.format, dialogueSchemaV2(current));
    assert.deepEqual(JSON.parse(body.messages[1].content), current);
    const decision = decideDialogueRules(current);
    const wire = decision.action === 'finish' ? decision : { action: decision.action, citations: decision.citations };
    return Response.json({ message: { content: JSON.stringify(wire) }, prompt_eval_count: 100, eval_count: 20, done_reason: 'stop' });
  }));
  assert.equal(run.records.length, 2); assert.equal(scoreDialogue(run, sample.label).supportedSuccess, true);
  assert.equal(Object.hasOwn(JSON.parse(run.turns[0]!.reply.rawOutput!), 'conclusion'), false);
  assert.equal((run.turns[0]!.reply.candidate as { conclusion: string }).conclusion, 'none');
  assert.equal(run.turns[0]!.reply.transport?.doneReason, 'stop');
});

test('V2 retains bounded diagnostics and refuses financial instructions', async () => {
  const call = (request: typeof fetch) => callDialogueModelV2(view(), 'fixture', request);
  const financial = await call(async () => Response.json({ message: { content: '{"action":"pay","citations":["seed"]}' } }));
  assert.equal(financial.status, 'rejected'); assert.equal(financial.reason, 'action-not-available');
  const oversized = await call(async () => new Response('x'.repeat(65537))); assert.equal(oversized.reason, 'response-too-large');
  const truncated = await call(async () => Response.json({ message: { content: 'x'.repeat(8001) } }));
  assert.equal(truncated.transport?.rawOutputTruncated, true); assert.equal(truncated.rawOutput?.length, 8000);
  const malformed = await call(async () => Response.json({ message: { content: '{bad' } })); assert.equal(malformed.reason, 'invalid-output-json');
  const http = await call(async () => new Response('', { status: 503 })); assert.equal(http.reason, 'http-503');
  const timeout = await call(async () => { throw new DOMException('expired', 'TimeoutError'); }); assert.equal(timeout.reason, 'timeout');
});

test('V2 records development reuse and preserves V1 failed-run dependencies and labels', async () => {
  const original = JSON.parse(await readFile(new URL('../../docs/evidence/stage-9-investigation-dialogue.json.plan.json', import.meta.url), 'utf8'));
  await assertFrozenSources(await dialogueSourceHashes(), original.files);
  const plan = await planDialogueV2(null);
  assert.deepEqual(plan.cases, original.cases); assert.equal(plan.datasetDigest, original.datasetDigest);
  assert.match(plan.limitation, /after observing V1/); assert.equal(plan.holdout, false);
  const result = await evaluateDialogueV2(plan); assert.equal(result.groups[0]!.summary.supportedSuccesses, 8);
  plan.maxReads = 4; await assert.rejects(evaluateDialogueV2(plan), /plan changed/);
});
