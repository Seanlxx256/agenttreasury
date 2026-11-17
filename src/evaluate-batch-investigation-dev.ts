import { createHash } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { developmentCases, type DevCase } from './batch-investigation-dev-cases.js';
import { decideDevRules, devOptions, devPrompt, runDevModel, type EvidenceView } from './batch-investigation-dev.js';
import type { BatchDecision } from './batch-investigation-eval.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function scoreDevDecision(decision: BatchDecision | null, label: DevCase['label'], candidateStatus?: string | null) {
  const checks = [...new Set(decision?.checks ?? [])], paths = [...new Set(decision?.citations ?? [])];
  const requiredChecksFound = label.requiredChecks.filter((check) => checks.includes(check)).length;
  const requiredPathsFound = label.requiredPaths.filter((path) => paths.includes(path)).length;
  const supportedPaths = paths.filter((path) => label.allowedPaths.includes(path)).length;
  const correct = decision?.status === label.status;
  return { correct, requiredChecksFound, requiredChecks: label.requiredChecks.length,
    requiredPathsFound, requiredPaths: label.requiredPaths.length, supportedPaths, citedPaths: paths.length,
    // Annotation agreement, not a semantic entailment evaluator or a human correctness judgment.
    unsupportedByAnnotation: paths.length - supportedPaths,
    falseCorroboration: label.status !== 'corroborated' && (decision?.status ?? candidateStatus) === 'corroborated',
    strictSuccess: !!decision && correct && requiredChecksFound === label.requiredChecks.length
      && requiredPathsFound === label.requiredPaths.length && supportedPaths === paths.length };
}
export function summarizeDevScores(rows: ReturnType<typeof scoreDevDecision>[]) {
  const sum = (key: keyof Pick<ReturnType<typeof scoreDevDecision>, 'requiredChecksFound' | 'requiredChecks' | 'requiredPathsFound'
    | 'requiredPaths' | 'supportedPaths' | 'citedPaths' | 'unsupportedByAnnotation'>) => rows.reduce((total, row) => total + row[key], 0);
  return { cases: rows.length, correct: rows.filter((row) => row.correct).length,
    strictSuccesses: rows.filter((row) => row.strictSuccess).length,
    falseCorroborations: rows.filter((row) => row.falseCorroboration).length,
    requiredCheckRecall: sum('requiredChecks') ? sum('requiredChecksFound') / sum('requiredChecks') : null,
    requiredPathRecall: sum('requiredPaths') ? sum('requiredPathsFound') / sum('requiredPaths') : null,
    annotatedPathPrecision: sum('citedPaths') ? sum('supportedPaths') / sum('citedPaths') : null,
    unsupportedByAnnotation: sum('unsupportedByAnnotation') };
}

export async function devSourceHashes() {
  const files: Record<string, string> = {};
  const seen = new Set<string>();
  async function visit(name: string) {
    if (seen.has(name)) return; seen.add(name);
    const source = await readFile(new URL(`../../src/${name}.ts`, import.meta.url), 'utf8');
    files[`src/${name}.ts`] = sha(source);
    files[`dist/src/${name}.js`] = sha(await readFile(new URL(name + '.js', import.meta.url)));
    for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+)\.js['"]/g)) await visit(match[1]!);
  }
  await visit('evaluate-batch-investigation-dev');
  files['package-lock.json'] = sha(await readFile(new URL('../../package-lock.json', import.meta.url)));
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export async function planDevEvaluation(models: string[], request: typeof fetch = fetch) {
  if (new Set(models).size !== models.length || models.some((model) => !['qwen2.5:1.5b', 'qwen2.5:3b'].includes(model))) {
    throw new Error('Use unique installed development models: qwen2.5:1.5b,qwen2.5:3b');
  }
  let ollama: unknown = null;
  const identities: Array<{ name: string; digest: string; details: unknown }> = [];
  if (models.length) {
    const tagsResponse = await request('http://127.0.0.1:11434/api/tags', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!tagsResponse.ok) throw new Error('Cannot identify installed models');
    const tags = await tagsResponse.json();
    for (const name of models) {
      const installed = tags.models?.find((row: { name: string }) => row.name === name);
      if (!installed || typeof installed.digest !== 'string' || !/^[a-f0-9]{64}$/.test(installed.digest)) throw new Error('Missing model identity');
      identities.push({ name, digest: installed.digest, details: installed.details });
    }
    const version = await request('http://127.0.0.1:11434/api/version', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!version.ok) throw new Error('Cannot identify Ollama version'); ollama = await version.json();
  }
  const cases = developmentCases();
  return { protocol: 'batch-investigation-development-v1', createdAt: new Date().toISOString(), node: process.version, ollama,
    models: identities, options: devOptions, prompt: devPrompt, files: await devSourceHashes(), cases,
    datasetDigest: sha(JSON.stringify(cases)), independentReview: false, holdout: false, promotionEligible: false,
    order: models.flatMap((model) => cases.flatMap((sample, index) =>
      (index % 2 ? ['compact', 'full'] : ['full', 'compact']).map((view) => ({ model, id: sample.id, view: view as EvidenceView })))),
    limitation: 'Single-author synthetic development cases; shared generator and non-independent labels. Both views receive identical backend comparisons. Compact removes raw records. No comparison to Stage 7 accuracy, operator ROI claim, financial authority or production promotion.' };
}

export async function evaluateDevPlan(plan: Awaited<ReturnType<typeof planDevEvaluation>>, request: typeof fetch = fetch,
  onCall: (row: unknown) => Promise<void> = async () => {}, progress: (message: string) => void = () => {}) {
  // Prevent a plan from silently running against edited source/data or a changed local runtime.
  if (plan.node !== process.version || JSON.stringify(plan.files) !== JSON.stringify(await devSourceHashes())
    || plan.datasetDigest !== sha(JSON.stringify(developmentCases())) || plan.datasetDigest !== sha(JSON.stringify(plan.cases))) {
    throw new Error('Development plan changed before execution');
  }
  const rules = plan.cases.map((sample) => {
    const start = performance.now(), decision = decideDevRules(sample.evidence);
    return { id: sample.id, decision, durationMs: performance.now() - start, ...scoreDevDecision(decision, sample.label) };
  });
  const calls: Array<{ model: string; id: string } & Awaited<ReturnType<typeof runDevModel>> & ReturnType<typeof scoreDevDecision>> = [];
  for (const item of plan.order) {
    const sample = plan.cases.find((row) => row.id === item.id)!;
    progress(`${item.model} ${item.view}: ${item.id}`);
    const run = await runDevModel(sample.evidence, item.view, item.model, request);
    const row = { ...item, ...run, ...scoreDevDecision(run.decision, sample.label, run.candidateStatus) };
    calls.push(row); await onCall(row);
  }
  const groups = plan.models.flatMap(({ name }) => (['full', 'compact'] as const).map((view) => {
    const rows = calls.filter((row) => row.model === name && row.view === view);
    return { model: name, view, ...summarizeDevScores(rows), ready: rows.filter((row) => row.status === 'ready').length,
      rejected: rows.filter((row) => row.status === 'rejected').length, unavailable: rows.filter((row) => row.status === 'unavailable').length,
      meanDurationMs: rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length,
      inputBytes: rows.reduce((sum, row) => sum + row.inputBytes, 0),
      promptTokens: rows.reduce((sum, row) => sum + (row.promptTokens ?? 0), 0),
      outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      usageMissing: rows.filter((row) => row.promptTokens === null || row.outputTokens === null).length };
  }));
  return { protocol: plan.protocol, completedAt: new Date().toISOString(), planDigest: sha(JSON.stringify(plan)),
    rules: { summary: summarizeDevScores(rules), cases: rules }, groups, calls,
    independentReview: false, promotionEligible: false, limitation: plan.limitation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { models: { type: 'string' }, 'rules-only': { type: 'boolean' }, output: { type: 'string' } } });
  const models = values.models?.split(',').filter(Boolean) ?? [];
  if (!values.output || (values['rules-only'] && models.length) || (!values['rules-only'] && !models.length)) {
    throw new Error('Specify --output <new.json> and either --rules-only or --models qwen2.5:1.5b,qwen2.5:3b');
  }
  const plan = await planDevEvaluation(models);
  // Exclusive creation preserves previous results. The plan precedes inference and JSONL survives interruption.
  const planFile = await open(values.output + '.plan.json', 'wx');
  try { await planFile.writeFile(JSON.stringify(plan, null, 2) + '\n'); } finally { await planFile.close(); }
  const reportFile = await open(values.output, 'wx');
  try {
    const callsFile = await open(values.output + '.calls.jsonl', 'wx');
    try {
      const report = await evaluateDevPlan(plan, fetch, async (row) => {
        await callsFile.writeFile(JSON.stringify(row) + '\n'); await callsFile.sync();
      }, (message) => console.error(message));
      await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n');
      console.error(JSON.stringify({ rules: report.rules.summary, groups: report.groups }, null, 2));
    } finally { await callsFile.close(); }
  } finally { await reportFile.close(); }
}
