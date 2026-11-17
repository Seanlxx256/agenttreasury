import type { PacketIssue, PacketSource } from './gateway-case-packet.js';

// Conservative English cues, not a semantic classifier. A cue holds the whole source
// for review: it does not decide which clause is true or whether the payment succeeded.
const cues: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'possible-negation', pattern: /\b(?:not|never|no|(?:is|was|have|has|had|did|do|does|were|are)n['’]t)\b[^.!?\n]{0,80}\b(?:duplicate|charged twice|two charges|refund|delivery|unusable)\b/i },
  { kind: 'possible-negation', pattern: /\b(?:refund|delivery|duplicate(?: charge)?|two charges)\b[^.!?\n]{0,32}\b(?:not|never)\b/i },
  { kind: 'possible-hypothetical', pattern: /\b(?:if|suppose|hypothetical|in case)\b/i },
  { kind: 'possible-retraction-or-resolution', pattern: /\b(?:retract(?:ed)?|withdraw(?:n)?|withdrew|resolved|no (?:remaining complaint|further action)|now opens? normally)\b/i },
  { kind: 'possible-quoted-instruction', pattern: /\b(?:ignore (?:your|all|previous)|(?:file|message|text|line)[^.!?\n]{0,40}(?:reads|says)|classify this as|authorize a payout)\b|["“”`]/i },
];
const pair = (issue: PacketIssue) => JSON.stringify([issue.sourceId, issue.topic]);

export function reviewPacketContext(sources: PacketSource[], rules: PacketIssue[], model: { status: string; issues: PacketIssue[] },
  originalModelSources: PacketSource[] = sources) {
  const claims = sources.filter((s) => s.kind === 'party-claim');
  const signals = claims.flatMap((source) => cues.flatMap(({ kind, pattern }) => {
    const match = pattern.exec(String(source.data.text ?? ''));
    return match ? [{ sourceId: source.id, kind, quote: match[0], offset: match.index }] : [];
  }));
  const rulePairs = new Set(rules.map(pair)), modelPairs = new Set(model.issues.map(pair));
  const disagreements = model.status === 'ready' ? [...new Set([...rulePairs, ...modelPairs])].filter((key) => rulePairs.has(key) !== modelPairs.has(key))
    .map((key) => { const [sourceId, topic] = JSON.parse(key); return { sourceId: String(sourceId), topic: String(topic),
      presentIn: rulePairs.has(key) ? 'rules-only' : 'model-only' }; }) : [];
  const disagreementKeys = new Set(disagreements.map((d) => JSON.stringify([d.sourceId, d.topic])));
  const candidates = [...rules.map((issue) => ({ issue, origin: 'rules' })),
    ...model.issues.map((issue) => ({ issue, origin: 'model' }))].map(({ issue, origin }) => {
    const source = claims.find((s) => s.id === issue.sourceId);
    const reasons = signals.filter((s) => s.sourceId === issue.sourceId).map((s) => s.kind);
    if (!source || !String(source.data.text ?? '').includes(issue.quote)) reasons.push('quote-not-in-current-source');
    if (origin === 'model') {
      const original = originalModelSources.find((s) => s.id === issue.sourceId);
      if (!original || !source || original.data.text !== source.data.text) reasons.push('source-changed-since-model');
    }
    if (disagreementKeys.has(pair(issue))) reasons.push('rule-model-disagreement');
    return { ...issue, origin, disposition: reasons.length ? 'held-for-review' : 'eligible-unverified', reasons: [...new Set(reasons)] };
  });
  const eligibleIssues = [...new Map(candidates.filter((c) => c.disposition === 'eligible-unverified')
    .map(({ topic, sourceId, quote }) => [JSON.stringify([topic, sourceId, quote]), { topic, sourceId, quote }])).values()];
  return { version: 1, policy: 'conservative-source-context-v1', signals, disagreements, candidates, eligibleIssues,
    needsOperatorReview: signals.length > 0 || candidates.some((c) => c.disposition === 'held-for-review'),
    limitation: 'English heuristic cues and rule/model differences trigger review, not truth verification. A whole-source hold can include valid current complaints. No cue does not prove a claim is current. Other languages and unrecognized paraphrases can escape these checks.' };
}
