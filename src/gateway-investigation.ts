import { resolveTriageModelProfile } from './gateway-triage-models.js';

// Read-only investigation suggestions. When the evidence conflicts, the triage
// action asks an operator to review, but it does not say what to look at first.
// This module proposes the next read-only check from a small closed set. Every
// suggestion is a query, never a state change: the backend never executes it,
// it only surfaces it to the operator.

export const investigationKinds = [
  'read-original-authorization',
  'read-gateway-status',
  'read-chain-receipt',
  'read-batch-calldata',
  'read-local-journal',
  'read-refund-status',
  'read-merchant-recipient',
  'compare-transfer-terms',
] as const;
export type InvestigationKind = (typeof investigationKinds)[number];

export const investigationKindDescriptions: Record<InvestigationKind, string> = {
  'read-original-authorization': 'Pull the original authorization and its task budget.',
  'read-gateway-status': 'Query the latest Gateway status for the request.',
  'read-chain-receipt': 'Read the on-chain transfer receipt or batch evidence.',
  'read-batch-calldata': 'Inspect the batch calldata for this transfer.',
  'read-local-journal': 'Review the local payment journal entry.',
  'read-refund-status': 'Check the refund request and its broadcast status.',
  'read-merchant-recipient': 'Verify the merchant payout address on file.',
  'compare-transfer-terms': 'Compare nonce, amount, recipient, and network across records.',
};

export type InvestigationSuggestion = { kind: InvestigationKind; citations: string[] };

// The rule baseline is a fixed generic checklist for any conflict: confirm what
// the chain recorded, what the local books recorded, and that the two agree.
const DEFAULT_INVESTIGATIONS: InvestigationKind[] =
  ['read-chain-receipt', 'read-local-journal', 'compare-transfer-terms'];

export function suggestInvestigationsRules(): InvestigationSuggestion[] {
  return DEFAULT_INVESTIGATIONS.map((kind) => ({ kind, citations: [] }));
}

const investigationSystemPrompt = [
  'You are proposing the next read-only checks for a payment conflict.',
  'Read the facts and return JSON with one field "investigations": an array of objects, each with "kind" and "citations".',
  'Kinds:',
  ...investigationKinds.map((kind) => '- ' + kind + ': ' + investigationKindDescriptions[kind]),
  'Choose only the checks that would change what the operator does next, in the order they should run.',
  'For each check, cite the fact IDs that show why it is needed. Do not invent facts. At most three checks.',
].join('\n');

export async function suggestInvestigationsWithModel(
  facts: Array<{ id: string; description: string }>, model?: string, request: typeof fetch = fetch,
): Promise<{ status: 'disabled' | 'ready' | 'unavailable' | 'rejected'; investigations: InvestigationSuggestion[] }> {
  if (!model) return { status: 'disabled', investigations: suggestInvestigationsRules() };
  const profile = resolveTriageModelProfile(model);
  const schema = {
    type: 'object', required: ['investigations'], additionalProperties: false,
    properties: {
      investigations: {
        type: 'array', maxItems: 3, items: {
          type: 'object', required: ['kind', 'citations'], additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: [...investigationKinds] },
            citations: { type: 'array', uniqueItems: true, items: { type: 'string', enum: facts.map(({ id }) => id) } },
          },
        },
      },
    },
  };
  try {
    const response = await request('http://127.0.0.1:11434/api/chat', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, format: schema, options: profile.options,
        messages: [
          { role: 'system', content: investigationSystemPrompt },
          { role: 'user', content: JSON.stringify({ facts }) },
        ],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: 'unavailable', investigations: suggestInvestigationsRules() };
    }
    const envelope = await response.json();
    const content = envelope?.message?.content;
    let parsed: unknown;
    if (typeof content === 'string' && content.length <= 4000) {
      try { parsed = JSON.parse(content); } catch { /* rejected below */ }
    }
    if (parsed && typeof parsed === 'object' && 'investigations' in parsed && Array.isArray(parsed.investigations) &&
        parsed.investigations.every((item) =>
          item && typeof item === 'object' && 'kind' in item && 'citations' in item &&
          typeof item.kind === 'string' && investigationKinds.includes(item.kind as InvestigationKind) &&
          Array.isArray(item.citations) && item.citations.every((id: unknown) => typeof id === 'string' && facts.some((fact) => fact.id === id)))) {
      return { status: 'ready', investigations: parsed.investigations as InvestigationSuggestion[] };
    }
    return { status: 'rejected', investigations: suggestInvestigationsRules() };
  } catch {
    return { status: 'unavailable', investigations: suggestInvestigationsRules() };
  }
}
