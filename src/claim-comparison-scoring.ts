import type { AssessedClaim, SuppliedMaterial } from './gateway-claim-assessment.js';
import { statementSources, type PacketIssue, type PacketStatements } from './gateway-case-packet.js';

export type ReviewedClaimCase = { id: string; input: PacketStatements;
  annotation: { claims: AssessedClaim[]; materials: SuppliedMaterial[]; rationale: string } };
export const claimScoringProtocol = Object.freeze({
  version: 'reviewed-claims-scoring-v1',
  activeStates: ['current', 'uncertain'],
  topicIdentity: 'sourceId + topic; deduplicated sets',
  support: 'exact source membership and a reviewer-labelled span inside the quote for the same source/topic; not independent semantic truth',
  failedAttempts: 'zero exact/support success, zero true positives, all expected active pairs missed; no rule fallback credit',
  materialIdentity: 'sourceId + field + exact quote; deduplicated',
  materials: 'deterministic parser reported separately; raw structured-model materials are diagnostic, not production checklist quality',
  workflow: 'same context/disagreement gate for all arms; held matching answers do not receive autonomous success',
  intervals: 'Wilson 95% descriptive intervals assume Bernoulli trials; synthetic cases can be correlated',
  promotion: 'none; accuracy, workload reduction and independent review are not certified',
});
const unique = <T>(values: T[], key: (value: T) => string) => [...new Map(values.map((v) => [key(v), v])).values()];
const topic = (c: PacketIssue) => JSON.stringify([c.sourceId, c.topic]);
const quote = (c: PacketIssue) => JSON.stringify([c.sourceId, c.topic, c.quote]);
const state = (c: AssessedClaim) => JSON.stringify([c.sourceId, c.topic, c.state]);
const same = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
const member = (input: PacketStatements, sourceId: string, text: string) => statementSources(input).some((s) => s.id === sourceId && String(s.data.text).includes(text));

export function scoreReviewedClaims(sample: ReviewedClaimCase, issues: PacketIssue[], accepted: boolean) {
  const gold = sample.annotation.claims.filter((c) => claimScoringProtocol.activeStates.includes(c.state));
  const expected = new Set(gold.map(topic)), predicted = new Set(accepted ? issues.map(topic) : []);
  const candidates = accepted ? unique(issues, quote) : [];
  const truePositives = [...expected].filter((key) => predicted.has(key)).length;
  const falsePositives = [...predicted].filter((key) => !expected.has(key)).length;
  const falseNegatives = expected.size - truePositives;
  const unsupported = candidates.filter((c) => !member(sample.input, c.sourceId, c.quote)
    || !gold.some((g) => topic(g) === topic(c) && c.quote.includes(g.quote))).length;
  const exact = accepted && falsePositives === 0 && falseNegatives === 0;
  return { accepted, exact, supportedExact: exact && unsupported === 0, truePositives, falsePositives, falseNegatives,
    unsupported, candidateQuotes: candidates.length, expectedPairs: expected.size };
}

export function scoreAssertionStates(sample: ReviewedClaimCase, claims: AssessedClaim[], accepted: boolean) {
  const candidates = unique(claims, (c) => JSON.stringify([state(c), c.quote]));
  const exact = accepted && same(claims.map(state), sample.annotation.claims.map(state));
  const unsupported = candidates.filter((c) => !member(sample.input, c.sourceId, c.quote)
    || !sample.annotation.claims.some((g) => state(g) === state(c) && c.quote.includes(g.quote))).length;
  return { exact, supportedExact: exact && unsupported === 0, unsupported };
}

export function scoreReviewedMaterials(sample: ReviewedClaimCase, materials: SuppliedMaterial[], accepted = true) {
  const key = (m: SuppliedMaterial) => JSON.stringify([m.sourceId, m.field, m.quote]);
  const candidates = accepted ? unique(materials, key) : [], expected = unique(sample.annotation.materials, key);
  const supports = (c: SuppliedMaterial, g: SuppliedMaterial) => c.sourceId === g.sourceId && c.field === g.field
    && member(sample.input, c.sourceId, c.quote) && c.quote.includes(g.quote);
  const found = expected.filter((g) => candidates.some((c) => supports(c, g))).length;
  const unsupported = candidates.filter((c) => !expected.some((g) => supports(c, g))).length;
  return { accepted, expected: expected.length, found, missed: expected.length - found, candidates: candidates.length, unsupported,
    exact: accepted && found === expected.length && unsupported === 0 };
}

export function wilson95(successes: number, total: number) {
  if (!total) return null;
  const z = 1.959963984540054, p = successes / total, denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return { low: Math.max(0, center - radius), high: Math.min(1, center + radius) };
}
