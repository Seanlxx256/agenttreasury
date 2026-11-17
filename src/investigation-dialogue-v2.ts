import { dialogueDecisionError, dialogueOptions, dialoguePrompt, type DialogueReply, type DialogueView } from './investigation-dialogue.js';

// V1 required a placeholder conclusion on every read. Preserve V1; use two disjoint wire shapes here.
export const dialoguePromptV2 = dialoguePrompt.replace(
  'Return exactly action, conclusion and citations. A read uses conclusion none; finish uses corroborated, conflict or incomplete.',
  'Use exactly one JSON shape: a read is {"action":"read tool name","citations":["visible ID"]}; finish is {"action":"finish","conclusion":"corroborated or conflict or incomplete","citations":["visible ID"]}. Never include a conclusion on a read.');

export function dialogueSchemaV2(view: DialogueView) {
  const citations = { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: view.permittedCitations } };
  const finish = { type: 'object', additionalProperties: false, required: ['action', 'conclusion', 'citations'], properties: {
    action: { type: 'string', enum: ['finish'] }, conclusion: { type: 'string', enum: ['corroborated', 'conflict', 'incomplete'] }, citations } };
  return view.availableTools.length ? { anyOf: [
    { type: 'object', additionalProperties: false, required: ['action', 'citations'], properties: {
      action: { type: 'string', enum: view.availableTools }, citations } }, finish,
  ] } : finish;
}

export function decodeDialogueV2(value: unknown, view: DialogueView) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: 'object-required', candidate: value };
  const wire = value as Record<string, unknown>;
  if (wire.action === 'finish') return { reason: dialogueDecisionError(value, view), candidate: value };
  if (Object.keys(wire).sort().join(',') !== 'action,citations') return { reason: 'read-shape-requires-action-and-citations-only', candidate: value };
  // Canonical internal marker, not an inferred or repaired model verdict. Raw wire output is retained separately.
  const candidate = { ...wire, conclusion: 'none' };
  return { reason: dialogueDecisionError(candidate, view), candidate };
}

export async function callDialogueModelV2(view: DialogueView, model: string, request: typeof fetch = fetch): Promise<DialogueReply> {
  const start = performance.now(), content = JSON.stringify(view);
  const transport: NonNullable<DialogueReply['transport']> = { httpStatus: null, doneReason: null, rawOutputTruncated: false, inputBytes: Buffer.byteLength(content) };
  let rawOutput: string | null = null, promptTokens: number | null = null, outputTokens: number | null = null;
  const result = (status: DialogueReply['status'], reason: string | null, candidate: unknown = null): DialogueReply => ({
    status, reason, candidate, rawOutput, promptTokens, outputTokens, transport, durationMs: performance.now() - start });
  if (transport.inputBytes > 24000) return result('rejected', 'input-too-large');
  try {
    const response = await request('http://127.0.0.1:11434/api/chat', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, options: dialogueOptions,
        format: dialogueSchemaV2(view), messages: [{ role: 'system', content: dialoguePromptV2 }, { role: 'user', content }] }) });
    transport.httpStatus = response.status;
    if (!response.ok) { await response.body?.cancel(); return result('unavailable', `http-${response.status}`); }
    const reader = response.body?.getReader(); if (!reader) return result('unavailable', 'empty-response');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 65536) { await reader.cancel(); return result('rejected', 'response-too-large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let envelope;
    try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return result('unavailable', 'invalid-envelope-json'); }
    if (!envelope || typeof envelope.message?.content !== 'string') return result('rejected', 'content-required');
    promptTokens = Number.isSafeInteger(envelope.prompt_eval_count) && envelope.prompt_eval_count >= 0 ? envelope.prompt_eval_count : null;
    outputTokens = Number.isSafeInteger(envelope.eval_count) && envelope.eval_count >= 0 ? envelope.eval_count : null;
    transport.doneReason = typeof envelope.done_reason === 'string' ? envelope.done_reason.slice(0, 40) : null;
    transport.rawOutputTruncated = envelope.message.content.length > 8000;
    rawOutput = envelope.message.content.slice(0, 8000);
    if (transport.rawOutputTruncated) return result('rejected', 'content-too-large-truncated');
    let wire;
    try { wire = JSON.parse(rawOutput!); } catch { return result('rejected', 'invalid-output-json'); }
    const { candidate, reason } = decodeDialogueV2(wire, view);
    return result(reason ? 'rejected' : 'ready', reason, candidate);
  } catch (error) {
    return result('unavailable', error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'transport-error');
  }
}
