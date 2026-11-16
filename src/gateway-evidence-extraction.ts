import { resolveTriageModelProfile } from './gateway-triage-models.js';

// Unstructured evidence extraction. The deterministic Gateway evidence path
// only ever sees structured fields (status, hash, amount, nonce). Real failure
// reasons live in free-text error strings, and a fixed keyword table cannot
// enumerate every way a vendor phrases "nonce already used". This module
// extracts a small closed set of signals from free text, both with a rule
// baseline (keyword matching) and with a model (semantic reading), so the two
// can be compared on the same held-out inputs.

export const evidenceSignals = [
  'nonce-reused',
  'insufficient-funds',
  'recipient-not-whitelisted',
  'invalid-signature',
  'batch-already-processed',
  'authorization-expired',
  'rpc-unavailable',
  'unknown-error',
] as const;
export type EvidenceSignal = (typeof evidenceSignals)[number];

export type ExtractedEvidence = { signal: EvidenceSignal; quote: string };

const rulePatterns: Array<{ signal: EvidenceSignal; pattern: RegExp }> = [
  { signal: 'nonce-reused', pattern: /\bnonce\b[^.;]{0,60}\b(already used|already consumed|reused|duplicate|replayed)\b/i },
  { signal: 'insufficient-funds', pattern: /\b(insufficient|not enough|out of)\b[^.;]{0,40}\b(funds|balance|gas)\b/i },
  { signal: 'recipient-not-whitelisted', pattern: /\b(recipient|payee|destination)\b[^.;]{0,60}\b(not whitelisted|not allowed|unauthorized|not permitted)\b/i },
  { signal: 'invalid-signature', pattern: /\bsignature\b[^.;]{0,60}\b(invalid|failed|does not match|mismatch)\b/i },
  { signal: 'batch-already-processed', pattern: /\bbatch\b[^.;]{0,60}\b(already processed|already settled|duplicate|replayed)\b/i },
  { signal: 'authorization-expired', pattern: /\b(authorization|validbefore|valid-before)\b[^.;]{0,60}\b(expired|elapsed|past)\b/i },
  { signal: 'rpc-unavailable', pattern: /\b(rpc|timeout|timed out|connection refused|network error|rate limit|429)\b/i },
];

export function extractEvidenceRules(text: string): ExtractedEvidence[] {
  const found: ExtractedEvidence[] = [];
  for (const { signal, pattern } of rulePatterns) {
    if (pattern.test(text)) {
      found.push({ signal, quote: text.match(pattern)?.[0] ?? '' });
    }
  }
  return found;
}

const extractSystemPrompt = [
  'Read the payment error text and list which of the following failure signals it states.',
  'Return JSON with one field "signals": an array of signal names only.',
  'Signal meanings:',
  '- nonce-reused: the same authorization signature identifier (nonce) was submitted twice.',
  '  Do NOT use this merely because something happened twice or a past record was referenced again.',
  '- insufficient-funds: the wallet did not have enough balance to settle.',
  '- recipient-not-whitelisted: the destination address was not on the allowed list.',
  '- invalid-signature: the authorization signature did not verify against the key.',
  '- batch-already-processed: the batch or settlement was already booked before.',
  '- authorization-expired: the authorization window (its valid-before deadline) has passed.',
  '- rpc-unavailable: the node or API could not be reached, including timeout, connection refused, rate limiting (429), throttling, or no response.',
  '- unknown-error: none of the above clearly applies.',
  'List a signal ONLY when the text states its condition directly. If no signal clearly applies, prefer unknown-error. Never list a signal the text does not support.',
].join('\n');

export async function extractEvidenceWithModel(
  text: string, model?: string, request: typeof fetch = fetch,
): Promise<{ status: 'disabled' | 'ready' | 'unavailable' | 'rejected'; signals: EvidenceSignal[] }> {
  if (!model) return { status: 'disabled', signals: [] };
  const profile = resolveTriageModelProfile(model);
  const schema = {
    type: 'object', required: ['signals'], additionalProperties: false,
    properties: {
      signals: { type: 'array', uniqueItems: true, maxItems: 3, items: { type: 'string', enum: [...evidenceSignals] } },
    },
  };
  try {
    const response = await request('http://127.0.0.1:11434/api/chat', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, format: schema, options: profile.options,
        messages: [
          { role: 'system', content: extractSystemPrompt },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: 'unavailable', signals: [] };
    }
    const envelope = await response.json();
    const content = envelope?.message?.content;
    let parsed: unknown;
    if (typeof content === 'string' && content.length <= 2000) {
      try { parsed = JSON.parse(content); } catch { /* rejected below */ }
    }
    if (parsed && typeof parsed === 'object' && 'signals' in parsed && Array.isArray(parsed.signals) &&
        parsed.signals.every((signal: unknown) => typeof signal === 'string' && evidenceSignals.includes(signal as EvidenceSignal))) {
      return { status: 'ready', signals: [...new Set(parsed.signals as EvidenceSignal[])] };
    }
    return { status: 'rejected', signals: [] };
  } catch {
    return { status: 'unavailable', signals: [] };
  }
}
