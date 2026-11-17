import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assembleCasePacket, interpretPacketClaims, packetRuleIssues, statementSources, type PacketIssue, type PacketStatements } from './gateway-case-packet.js';
import { loadPacketAnnotations, validatePacketAnnotations, comparePacketAnnotations, type ValidatedPacketAnnotations } from './case-packet-annotations.js';
import { exportPacketAnnotationForm, packetEvaluationCases, packetEvaluationSnapshot, type PacketEvaluationCase } from './case-packet-evaluation-cases.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const difference = (a: string[], b: string[]) => [...new Set(a)].filter((value) => !b.includes(value));
type Interpretation = Awaited<ReturnType<typeof interpretPacketClaims>>;

export function scorePacketTopics(issues: PacketIssue[], annotation: PacketEvaluationCase['annotation'], input: PacketStatements) {
  const topics = [...new Set(issues.map((issue) => issue.topic))], expected = [...new Set(annotation.issues.map((issue) => issue.topic))];
  const missing = difference(expected, topics), extra = difference(topics, expected);
  const unique = [...new Map(issues.map((issue) => [JSON.stringify([issue.topic, issue.sourceId, issue.quote]), issue])).values()];
  const sources = statementSources(input);
  const unsupported = unique.filter((candidate) => !sources.some((s) => s.id === candidate.sourceId && String(s.data.text).includes(candidate.quote)) || !annotation.issues.some((label) => label.topic === candidate.topic
    && label.sourceId === candidate.sourceId && candidate.quote.includes(label.quote)));
  return { topics, missing, extra, exact: !missing.length && !extra.length,
    minimumTopicSetEdits: missing.length + extra.length, candidateCount: unique.length, unsupportedCandidates: unsupported.length };
}

export function scorePacketWorkflow(packet: ReturnType<typeof assembleCasePacket>, sample: PacketEvaluationCase) {
  const rawCandidateScore = scorePacketTopics([...packet.ruleIssues.issues, ...packet.modelInterpretation.issues], sample.annotation, sample.input);
  const topics = scorePacketTopics(packet.candidateReview.eligibleIssues, sample.annotation, sample.input);
  const gaps = packet.evidenceGaps.map((gap) => gap.id);
  const missingMaterials = difference(sample.annotation.requiredGapIds, gaps), unnecessaryQuestions = difference(gaps, sample.annotation.requiredGapIds);
  return { ...topics, rawCandidateScore, needsOperatorReview: packet.candidateReview.needsOperatorReview, missingMaterials, unnecessaryQuestions, exactMaterialSet: !missingMaterials.length && !unnecessaryQuestions.length };
}

export async function evaluatePacketCase(sample: PacketEvaluationCase, model?: string, request: typeof fetch = fetch) {
  // Only the two input statements cross the model boundary. No case IDs, strata, labels or fixture ledger data.
  const sources = statementSources(sample.input), snapshot = packetEvaluationSnapshot(sample.recordedRefund);
  const disabled = await interpretPacketClaims([]);
  const baseline = assembleCasePacket(snapshot, sample.input, disabled);
  const interpretation = model ? await interpretPacketClaims(sources, model, request) : null;
  const assisted = interpretation ? assembleCasePacket(snapshot, sample.input, interpretation) : null;
  return { id: sample.id, stratum: sample.stratum, baseline: { issues: packetRuleIssues(sources), candidateReview: baseline.candidateReview, score: scorePacketWorkflow(baseline, sample) },
    model: interpretation ? { ...interpretation,
      score: interpretation.status === 'ready' ? scorePacketTopics(interpretation.issues, sample.annotation, sample.input) : null } : null,
    assisted: assisted ? { candidateReview: assisted.candidateReview, score: scorePacketWorkflow(assisted, sample),
      deterministicFactsUnchanged: isDeepStrictEqual(assisted.recordedFacts, baseline.recordedFacts),
      inquiryDraft: assisted.merchantInquiryDraft } : null };
}

type CaseResult = Awaited<ReturnType<typeof evaluatePacketCase>>;
export function summarizePacketEvaluation(rows: CaseResult[]) {
  const summarize = (scores: ReturnType<typeof scorePacketWorkflow>[]) => ({ cases: scores.length,
    exactTopicSets: scores.filter((score) => score.exact).length,
    exactTopicSetsWithoutReview: scores.filter((score) => score.exact && !score.needsOperatorReview).length,
    heldForReviewCases: scores.filter((score) => score.needsOperatorReview).length, exactMaterialSets: scores.filter((score) => score.exactMaterialSet).length,
    missingMaterials: scores.reduce((n, s) => n + s.missingMaterials.length, 0), unnecessaryQuestions: scores.reduce((n, s) => n + s.unnecessaryQuestions.length, 0),
    unsupportedCandidates: scores.reduce((n, s) => n + s.unsupportedCandidates, 0), candidateCount: scores.reduce((n, s) => n + s.candidateCount, 0),
    minimumTopicSetEdits: scores.reduce((n, s) => n + s.minimumTopicSetEdits, 0) });
  const attempted = rows.filter((row) => row.model !== null);
  return { baseline: summarize(rows.map((r) => r.baseline.score)),
    assisted: attempted.length ? summarize(attempted.map((r) => r.assisted!.score)) : null,
    model: attempted.length ? { attempted: attempted.length,
      statuses: Object.fromEntries(['ready', 'rejected', 'unavailable'].map((status) => [status, attempted.filter((r) => r.model!.status === status).length])),
      exactTopicSetsPerAttempt: attempted.filter((r) => r.model!.score?.exact).length,
      supportedExactTopicSetsPerAttempt: attempted.filter((r) => r.model!.score?.exact && r.model!.score!.unsupportedCandidates === 0).length,
      totalCallMs: attempted.reduce((n, r) => n + r.model!.durationMs, 0),
      deterministicFactsUnchanged: attempted.every((r) => r.assisted!.deterministicFactsUnchanged),
      improvedTopicSets: attempted.filter((r) => r.assisted!.score.minimumTopicSetEdits < r.baseline.score.minimumTopicSetEdits).length,
      worsenedTopicSets: attempted.filter((r) => r.assisted!.score.minimumTopicSetEdits > r.baseline.score.minimumTopicSetEdits).length } : null };
}

export async function packetEvaluationHashes() {
  const files: Record<string, string> = {}, visited = new Set<string>();
  async function visit(name: string) {
    if (visited.has(name)) return; visited.add(name);
    const source = await readFile(new URL(`../../src/${name}.ts`, import.meta.url), 'utf8');
    files[`src/${name}.ts`] = sha(source); files[`dist/src/${name}.js`] = sha(await readFile(new URL(name + '.js', import.meta.url)));
    for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+)\.js['"]/g)) await visit(match[1]!);
  }
  await visit('evaluate-case-packets');
  files['package-lock.json'] = sha(await readFile(new URL('../../package-lock.json', import.meta.url)));
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

async function localModelIdentity(name: string, request: typeof fetch) {
  const response = await request('http://127.0.0.1:11434/api/tags', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Local model identity unavailable');
  const identity = (await response.json()).models?.find((m: { name: string }) => m.name === name);
  if (!identity || typeof identity.digest !== 'string' || !identity.digest) throw new Error('Requested local model is not installed');
  return { name, digest: identity.digest };
}

export async function planPacketEvaluation(model: string | undefined, request: typeof fetch = fetch, annotationReview?: ValidatedPacketAnnotations) {
  return { protocol: 'case-packet-development-v2-context-review', createdAt: new Date().toISOString(), node: process.version,
    datasetDigest: sha(JSON.stringify(packetEvaluationCases())), files: await packetEvaluationHashes(),
    model: model ? await localModelIdentity(model, request) : null, independentReview: false, promotionEligible: false,
    annotationReview: annotationReview ?? null, labelSource: annotationReview ? annotationReview.reviewer.relationship : 'author-development',
    scope: (annotationReview ? 'Imported reviewer-declared labels; reviewer identity and independence are unverified. ' : 'Author-labelled evaluation. ') + 'Synthetic development evaluation; separate from Stage 10 smoke examples. Context gating was developed after observing Stage 13 results on these same cases. Not held-out or independently reviewed. No wallet, database or merchant calls.',
    scoring: 'Unsupported means no matching topic/source and annotated span in the quote, not independent truth verification. Topic-set edits are a theoretical lower bound, not measured human edits. Material coverage counts question categories, not complete document quality.' };
}

export async function runPacketEvaluation(plan: Awaited<ReturnType<typeof planPacketEvaluation>>, request: typeof fetch = fetch,
  capture: (row: CaseResult) => Promise<void> = async () => {}, progress: (id: string) => void = () => {}) {
  if (plan.node !== process.version || plan.datasetDigest !== sha(JSON.stringify(packetEvaluationCases()))
    || !isDeepStrictEqual(plan.files, await packetEvaluationHashes())) throw new Error('Evaluation sources changed after planning');
  const reviewed = plan.annotationReview ? validatePacketAnnotations(plan.annotationReview.form) : null;
  if (reviewed && reviewed.annotationDigest !== plan.annotationReview?.annotationDigest) throw new Error('Annotations changed after planning');
  const checkModel = async () => { if (plan.model && !isDeepStrictEqual(plan.model, await localModelIdentity(plan.model.name, request))) throw new Error('Model identity changed during evaluation'); };
  await checkModel();
  const rows: CaseResult[] = [];
  for (const sample of reviewed?.cases ?? packetEvaluationCases()) {
    progress(sample.id); await checkModel();
    const row = await evaluatePacketCase(sample, plan.model?.name, request); rows.push(row); await capture(row);
  }
  await checkModel();
  return { ...plan, finishedAt: new Date().toISOString(), summary: summarizePacketEvaluation(rows), cases: rows,
    limitations: 'Model failures remain in the attempt denominator; any valid rule fallback is a workflow result, not model success. Raw union candidates are retained but context holds require operator review; held cases are not autonomous successes. No human review duration, independently validated quality or ROI is measured.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, model: { type: 'string' },
    'rules-only': { type: 'boolean' }, 'export-review': { type: 'boolean' }, annotations: { type: 'string' },
    'validate-review': { type: 'boolean' }, 'compare-review': { type: 'string' } } });
  if (!values.output || [!!values.model, !!values['rules-only'], !!values['export-review'], !!values['validate-review'], !!values['compare-review']].filter(Boolean).length !== 1
    || (values['export-review'] && !!values.annotations) || ((values['validate-review'] || values['compare-review']) && !values.annotations))
    throw new Error('Specify --output <new.json> and one mode: --rules-only, --model <name>, --export-review, --validate-review, --compare-review <second.json>. Review validation/comparison requires --annotations <first.json>.');
  if (values['export-review']) {
    const file = await open(values.output, 'wx');
    try { await file.writeFile(JSON.stringify(exportPacketAnnotationForm(), null, 2) + '\n'); } finally { await file.close(); }
  } else if (values['validate-review'] || values['compare-review']) {
    const imported = await loadPacketAnnotations(values.annotations!);
    const result = values['compare-review'] ? comparePacketAnnotations(imported, await loadPacketAnnotations(values['compare-review'])) : imported;
    const file = await open(values.output, 'wx');
    try { await file.writeFile(JSON.stringify(result, null, 2) + '\n'); } finally { await file.close(); }
  } else {
    // Reserve output first; never overwrite or invoke a model for an already existing output path.
    const file = await open(values.output, 'wx');
    try {
      const annotations = values.annotations ? await loadPacketAnnotations(values.annotations) : undefined;
      const plan = await planPacketEvaluation(values.model, fetch, annotations);
      const planFile = await open(values.output + '.plan.json', 'wx');
      try { await planFile.writeFile(JSON.stringify(plan, null, 2) + '\n'); } finally { await planFile.close(); }
      const journal = await open(values.output + '.cases.jsonl', 'wx');
      try {
        const result = await runPacketEvaluation(plan, fetch, async (row) => { await journal.writeFile(JSON.stringify(row) + '\n'); await journal.sync(); }, console.error);
        await file.writeFile(JSON.stringify(result, null, 2) + '\n'); console.error(JSON.stringify(result.summary, null, 2));
      } finally { await journal.close(); }
    } finally { await file.close(); }
  }
}
