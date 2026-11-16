import type { Pool } from 'pg';
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

export interface CollectedGatewayPattern {
  merchantId: string | null;
  network: string | null;
  pattern: SystemicPattern;
  cases: PatternCase[];
  caseIds: string[];
  status: 'disabled' | 'ready' | 'unavailable' | 'rejected';
}

// Operational entry point: collect failed payment reasons from the observation
// log, grouped by merchant and network, and reduce each group to one systemic
// pattern. The finance console calls this to surface cross-case patterns from
// the data that already flows through the payment path, rather than from the
// evaluator.
//
// Each request contributes exactly ONE case: the latest failed observation for
// that request, so a payment queried twice is not double-counted as two
// independent failures. `since` bounds the window so stale history does not keep
// mixing into the current pattern.
export async function collectGatewayPatterns(
  pool: Pool, model?: string, request: typeof fetch = fetch, since?: Date,
): Promise<CollectedGatewayPattern[]> {
  const { rows } = await pool.query<{
    merchantId: string | null; network: string | null; reasons: string[]; requestIds: string[];
  }>(`
    WITH failed AS (
      SELECT DISTINCT ON (o.request_id)
             o.request_id, o.evidence->>'reason' AS reason, o.checked_at AS "checkedAt"
      FROM gateway_payment_observations o
      WHERE o.evidence->>'status' = 'failed' AND o.evidence->>'reason' IS NOT NULL
        AND o.evidence->>'reason' <> ''
        AND ($1::timestamptz IS NULL OR o.checked_at >= $1)
      ORDER BY o.request_id, o.id DESC
    )
    SELECT g.merchant_id AS "merchantId", p.network,
           array_agg(f.request_id::text ORDER BY f."checkedAt") AS "requestIds",
           array_agg(f.reason ORDER BY f."checkedAt") AS reasons
    FROM failed f
    JOIN gateway_demo_purchases p ON p.request_id = f.request_id
    JOIN gateway_task_grants g ON g.task_id = p.task_id
    GROUP BY g.merchant_id, p.network
  `, [since ?? null]);
  const collected: CollectedGatewayPattern[] = [];
  for (const { merchantId, network, reasons, requestIds } of rows) {
    const cases = reasons.map((text) => ({ text, dimension: network ?? 'unattributed' }));
    const result = await recognizePatternsWithModel(cases, model, request);
    collected.push({ merchantId, network, pattern: result.pattern, cases, caseIds: requestIds, status: result.status });
  }
  return collected;
}
