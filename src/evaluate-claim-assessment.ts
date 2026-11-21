import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { claimAssessmentCases } from './claim-assessment-cases.js';
import { interpretStructuredClaims } from './gateway-claim-assessment.js';
import { interpretPacketClaims, packetRuleIssues, statementSources, type PacketIssue } from './gateway-case-packet.js';
import { reviewPacketContext } from './gateway-case-packet-context.js';
import { packetEvaluationHashes } from './evaluate-case-packets.js';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const identity = (i: PacketIssue) => `${i.sourceId}:${i.topic}`;
const same = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
export function scoreCurrentClaims(issues: PacketIssue[], expected: PacketIssue[]) {
  const exact = same(issues.map(identity), expected.map(identity));
  const unsupported = issues.filter((i) => !expected.some((e) => identity(i) === identity(e) && i.quote.includes(e.quote))).length;
  return { exact, unsupported, supportedExact: exact && unsupported === 0 };
}
async function files() {
  const result = await packetEvaluationHashes();
  for (const name of ['claim-assessment-cases', 'evaluate-claim-assessment']) {
    for (const [path, url] of [[`src/${name}.ts`, new URL(`../../src/${name}.ts`, import.meta.url)],
      [`dist/src/${name}.js`, new URL(`${name}.js`, import.meta.url)]] as const) result[path] = sha(await readFile(url));
  }
  return result;
}
async function modelIdentity(model: string) {
  const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('Model inventory unavailable');
  const body = await response.json(); const entry = body.models?.find((m: { name: string }) => m.name === model);
  if (!entry?.digest) throw new Error('Requested model must already be installed');
  return { name: model, digest: String(entry.digest) };
}
export async function evaluateClaimAssessment(output: string, model: string) {
  // Reserve all artifacts before model inference; never overwrite an earlier run.
  const reportFile = await open(output, 'wx');
  let planFile: Awaited<ReturnType<typeof open>> | undefined, journal: Awaited<ReturnType<typeof open>> | undefined;
  try {
    planFile = await open(output + '.plan.json', 'wx'); journal = await open(output + '.cases.jsonl', 'wx');
    const plan = { protocol: 'claim-assessment-development-v1', startedAt: new Date().toISOString(), node: process.version,
      model: await modelIdentity(model), files: await files(), cases: claimAssessmentCases(),
      independentReview: false, holdout: false, promotionEligible: false,
      limitation: 'Author-labelled development cases designed after earlier failures. Paired extraction comparison, not human workload or production effectiveness.' };
    await planFile.writeFile(JSON.stringify(plan, null, 2) + '\n'); await planFile.sync();
    const rows = [];
    for (const [index, sample] of plan.cases.entries()) {
      if (JSON.stringify(await files()) !== JSON.stringify(plan.files) || JSON.stringify(await modelIdentity(model)) !== JSON.stringify(plan.model)) throw new Error('Evaluation identity changed');
      const sources = statementSources(sample.input);
      const expected = sample.expected.claims.filter((c) => c.state === 'current' || c.state === 'uncertain');
      const rules = reviewPacketContext(sources, packetRuleIssues(sources), { status: 'disabled', issues: [] });
      // Counterbalance call order; no simultaneous inference or rule fallback credit.
      const [legacy, structured] = index % 2 === 0
        ? [await interpretPacketClaims(sources, model), await interpretStructuredClaims(sources, model)]
        : await (async () => { const structured = await interpretStructuredClaims(sources, model); return [await interpretPacketClaims(sources, model), structured] as const; })();
      const stateExact = structured.status === 'ready' && same((structured.assessment?.claims ?? []).map((c) => `${identity(c)}:${c.state}`), sample.expected.claims.map((c) => `${identity(c)}:${c.state}`));
      const materials = structured.assessment?.materials ?? [];
      const supports = (candidate: typeof materials[number], label: typeof materials[number]) => candidate.field === label.field && candidate.sourceId === label.sourceId && candidate.quote.includes(label.quote);
      const row = { id: sample.id, rules: { score: scoreCurrentClaims(rules.eligibleIssues, expected), reviewRequired: rules.needsOperatorReview },
        legacy: { ...legacy, score: legacy.status === 'ready' ? scoreCurrentClaims(legacy.issues, expected) : null },
        structured: { ...structured, score: structured.status === 'ready' ? scoreCurrentClaims(structured.issues, expected) : null,
          stateExact, materialFound: sample.expected.materials.filter((m) => materials.some((c) => supports(c, m))).length,
          materialExpected: sample.expected.materials.length, materialUnsupported: materials.filter((c) => !sample.expected.materials.some((m) => supports(c, m))).length } };
      rows.push(row); await journal.writeFile(JSON.stringify(row) + '\n'); await journal.sync();
      console.error(`Completed paired case ${index + 1}/${plan.cases.length}`);
    }
    if (JSON.stringify(await files()) !== JSON.stringify(plan.files) || JSON.stringify(await modelIdentity(model)) !== JSON.stringify(plan.model)) throw new Error('Evaluation identity changed');
    const summary = { cases: rows.length, rulesCurrentExact: rows.filter((r) => r.rules.score.exact).length,
      legacyCurrentExact: rows.filter((r) => r.legacy.score?.exact).length,
      structuredCurrentExact: rows.filter((r) => r.structured.score?.exact).length,
      structuredSupportedCurrentExact: rows.filter((r) => r.structured.score?.supportedExact).length,
      structuredStateExact: rows.filter((r) => r.structured.stateExact).length,
      legacyRejectedOrUnavailable: rows.filter((r) => r.legacy.status !== 'ready').length,
      structuredRejectedOrUnavailable: rows.filter((r) => r.structured.status !== 'ready').length,
      materialFound: rows.reduce((n, r) => n + r.structured.materialFound, 0), materialExpected: rows.reduce((n, r) => n + r.structured.materialExpected, 0),
      unsupportedMaterialCandidates: rows.reduce((n, r) => n + r.structured.materialUnsupported, 0) };
    const report = { ...plan, finishedAt: new Date().toISOString(), summary, rows };
    await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportFile.sync(); return summary;
  } finally { await reportFile.close(); await planFile?.close(); await journal?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' }, model: { type: 'string' } } });
    if (!values.output || !values.model) throw new Error('Use --output NEW_FILE --model INSTALLED_MODEL');
    console.log(JSON.stringify(await evaluateClaimAssessment(values.output, values.model), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Evaluation failed'); process.exitCode = 1; }
}
