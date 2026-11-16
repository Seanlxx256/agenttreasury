import { resolveTriageModelProfile } from './gateway-triage-models.js';
import { extractEvidenceRules, type EvidenceSignal } from './gateway-evidence-extraction.js';

// Cross-case pattern recognition. A single case only shows one failure; several
// cases from the same supplier or network may expose a systemic problem (a
// supplier reusing nonces, a wallet that keeps running dry, a network outage).
// This module reduces a small batch of failure reasons to one systemic pattern
// from a closed set, both with a rule baseline (signal counting) and a model
// (reading the texts together).

export const systemicPatterns = [
  'supplier-nonce-bug',
  'wallet-funding-gap',
  'rpc-outage',
  'recipient-config-error',
  'signature-tooling-bug',
  'no-systemic-pattern',
] as const;
export type SystemicPattern = (typeof systemicPatterns)[number];

export type PatternCase = { text: string; dimension: string };

const signalToPattern: Record<EvidenceSignal, SystemicPattern> = {
  'nonce-reused': 'supplier-nonce-bug',
  'insufficient-funds': 'wallet-funding-gap',
  'recipient-not-whitelisted': 'recipient-config-error',
  'invalid-signature': 'signature-tooling-bug',
  'batch-already-processed': 'supplier-nonce-bug',
  'authorization-expired': 'no-systemic-pattern',
  'rpc-unavailable': 'rpc-outage',
  'unknown-error': 'no-systemic-pattern',
};

// The rule baseline extracts each case's signal by keyword and reports a
// systemic pattern when at least two cases share one signal.
export function recognizePatternsRules(cases: PatternCase[]): SystemicPattern {
  const signalCounts = new Map<EvidenceSignal, number>();
  for (const { text } of cases) {
    for (const { signal } of extractEvidenceRules(text)) {
      signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1);
    }
  }
  for (const [signal, count] of signalCounts) {
    if (count >= 2) return signalToPattern[signal];
  }
  return 'no-systemic-pattern';
}

const patternSystemPrompt = [
  'Read these failure reasons from one supplier or network and decide whether they expose one systemic problem.',
  'Return JSON with one field "pattern": a pattern name.',
  'Patterns:',
  '- supplier-nonce-bug: several failures come from the same identifier being reused or the batch being replayed.',
  '- wallet-funding-gap: several failures come from the wallet lacking balance.',
  '- rpc-outage: several failures come from the node or API being unreachable.',
  '- recipient-config-error: several failures come from a disallowed destination address.',
  '- signature-tooling-bug: several failures come from signatures that do not verify.',
  '- no-systemic-pattern: the failures are unrelated.',
  'Report a systemic pattern only when at least two failures share the same root cause, even if they phrase it differently.',
].join('\n');

export async function recognizePatternsWithModel(
  cases: PatternCase[], model?: string, request: typeof fetch = fetch,
): Promise<{ status: 'disabled' | 'ready' | 'unavailable' | 'rejected'; pattern: SystemicPattern }> {
  if (!model) return { status: 'disabled', pattern: recognizePatternsRules(cases) };
  const profile = resolveTriageModelProfile(model);
  const schema = {
    type: 'object', required: ['pattern'], additionalProperties: false,
    properties: { pattern: { type: 'string', enum: [...systemicPatterns] } },
  };
  const text = cases.map(({ text }) => '- ' + text).join('\n');
  try {
    const response = await request('http://127.0.0.1:11434/api/chat', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, format: schema, options: profile.options,
        messages: [
          { role: 'system', content: patternSystemPrompt },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: 'unavailable', pattern: recognizePatternsRules(cases) };
    }
    const envelope = await response.json();
    const content = envelope?.message?.content;
    let parsed: unknown;
    if (typeof content === 'string' && content.length <= 2000) {
      try { parsed = JSON.parse(content); } catch { /* rejected below */ }
    }
    if (parsed && typeof parsed === 'object' && 'pattern' in parsed &&
        typeof parsed.pattern === 'string' && systemicPatterns.includes(parsed.pattern as SystemicPattern)) {
      return { status: 'ready', pattern: parsed.pattern as SystemicPattern };
    }
    return { status: 'rejected', pattern: recognizePatternsRules(cases) };
  } catch {
    return { status: 'unavailable', pattern: recognizePatternsRules(cases) };
  }
}
