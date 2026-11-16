import { extractEvidenceRules, type ExtractedEvidence, type EvidenceSignal } from './gateway-evidence-extraction.js';

// Evaluation-only contextual control. Designed against the existing development
// taxonomy before running the new stress set; it does not replace runtime triage.
const paraphrases: Array<[EvidenceSignal, RegExp]> = [
  ['nonce-reused', /(?:authorization|transfer|identifier).*(?:submitted (?:twice|again)|signed twice|same identifier|second time)/i],
  ['insufficient-funds', /(?:wallet|account|balance).*(?:ran dry|cannot cover|could not cover|too (?:low|small)|below.*(?:cost|amount))/i],
  ['recipient-not-whitelisted', /(?:recipient|destination|address).*(?:missing from|not (?:on|in)).*(?:allow|accept|permit).*list/i],
  ['invalid-signature', /(?:authorization|signature).*(?:did not match.*key|did not verify|does not verify|verification rejected)/i],
  ['batch-already-processed', /(?:batch|settlement).*(?:booked earlier|previously booked|already recorded|already committed)/i],
  ['authorization-expired', /(?:payment|authorization).*(?:window (?:closed|ended)|deadline (?:passed|elapsed))/i],
  ['rpc-unavailable', /(?:node|gateway|endpoint|api).*(?:did not respond|never answered|unreachable|throttl|no response)/i],
];

const nonCurrent = /^(?:yesterday|previous incident|earlier incident|historical|example|documentation|manual|hypothetically|if\b|suppose\b|ignore\b|untrusted instruction)/i;
const denied = /\b(?:no evidence of|no sign of|ruled out|not caused by|has not expired|did not expire|did not fail|not an? (?:rpc|signature|balance)|not insufficient|never reused|was not reused|not already (?:used|processed|settled))\b/i;
const resolved = /\b(?:now (?:healthy|reachable|successful|sufficient)|has recovered|was resolved|is resolved|error cleared|retry succeeded)\b/i;

export function extractEvidenceContextRules(text: string): ExtractedEvidence[] {
  const results = new Map<EvidenceSignal, ExtractedEvidence>();
  for (const fragment of text.split(/[.!?;\n]+|\bbut\b|\bhowever\b/i)) {
    const clause = fragment.trim();
    if (!clause || nonCurrent.test(clause) || denied.test(clause) || resolved.test(clause)) continue;
    const signals = new Set(extractEvidenceRules(clause).map(({ signal }) => signal));
    for (const [signal, pattern] of paraphrases) if (pattern.test(clause)) signals.add(signal);
    for (const signal of signals) if (!results.has(signal)) results.set(signal, { signal, quote: clause });
  }
  return [...results.values()];
}
