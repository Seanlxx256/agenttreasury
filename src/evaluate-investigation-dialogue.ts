import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { dialogueCases, type DialogueCase } from './investigation-dialogue-cases.js';
import { callDialogueModel, dialogueOptions, dialoguePrompt, ruleDialoguePolicy, runDialogue } from './investigation-dialogue.js';

type Run = Awaited<ReturnType<typeof runDialogue>>;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function scoreDialogue(run: Run, label: DialogueCase['label']) {
  const retrieved = new Set(run.records.map((row) => row.tool));
  const relevant = new Set(label.witnesses.flatMap((witness) => witness.tools));
  const cited = [...new Set(run.final?.citations ?? [])];
  const sources: string[] = cited.map((id) => id === 'seed' ? 'seed' : run.records.find((row) => row.id === id)?.tool ?? 'unknown');
  const requiredEvidenceCoverage = Math.max(...label.witnesses.map((witness) => witness.tools.filter((tool) => retrieved.has(tool)).length / witness.tools.length));
  const sufficient = label.witnesses.some((witness) => witness.tools.every((tool) => retrieved.has(tool)));
  const supports = label.witnesses.map((witness) => {
    const required: string[] = [...witness.tools, ...(witness.seed ? ['seed'] : [])];
    const allowed = [...required, 'seed']; // Context may be cited, but never replaces the required records.
    return { exact: required.every((source) => sources.includes(source)) && sources.every((source) => allowed.includes(source)),
      matched: sources.filter((source) => allowed.includes(source)).length };
  });
  const supportedCitations = Math.max(0, ...supports.map((row) => row.matched));
  const correct = run.status === 'completed' && run.final?.conclusion === label.conclusion;
  const claimedCorroboration = run.turns.some((turn) => {
    const candidate = turn.reply.candidate;
    return candidate && typeof candidate === 'object' && (candidate as { conclusion?: unknown }).conclusion === 'corroborated';
  });
  return { correct, supportedSuccess: !!correct && sufficient && supports.some((row) => row.exact),
    reads: run.records.length, usefulReads: run.records.filter((row) => relevant.has(row.tool)).length,
    requiredEvidenceCoverage, prematureFinish: run.status === 'completed' && !sufficient,
    cited: cited.length, supportedCitations, unsupportedCitations: cited.length - supportedCitations,
    falseCorroboration: label.conclusion !== 'corroborated' && claimedCorroboration,
    unsupportedCorroboration: claimedCorroboration && (!correct || !sufficient || !supports.some((row) => row.exact)),
    modelCalls: run.turns.filter((turn) => turn.reply.rawOutput !== null || turn.reply.reason !== null).length,
    promptTokens: run.turns.reduce((sum, turn) => sum + (turn.reply.promptTokens ?? 0), 0),
    outputTokens: run.turns.reduce((sum, turn) => sum + (turn.reply.outputTokens ?? 0), 0) };
}

export function summarizeDialogues(rows: Array<{ run: Run; score: ReturnType<typeof scoreDialogue> }>) {
  const sum = (key: 'reads' | 'usefulReads' | 'cited' | 'supportedCitations' | 'unsupportedCitations' | 'modelCalls' | 'promptTokens' | 'outputTokens') => rows.reduce((n, row) => n + row.score[key], 0);
  return { cases: rows.length, correct: rows.filter((row) => row.score.correct).length,
    supportedSuccesses: rows.filter((row) => row.score.supportedSuccess).length,
    completed: rows.filter((row) => row.run.status === 'completed').length,
    rejected: rows.filter((row) => row.run.status === 'rejected').length,
    unavailable: rows.filter((row) => row.run.status === 'unavailable').length,
    exhausted: rows.filter((row) => row.run.status === 'exhausted').length,
    prematureFinishes: rows.filter((row) => row.score.prematureFinish).length,
    falseCorroborations: rows.filter((row) => row.score.falseCorroboration).length,
    unsupportedCorroborations: rows.filter((row) => row.score.unsupportedCorroboration).length,
    reads: sum('reads'), usefulReads: sum('usefulReads'), usefulReadRate: sum('reads') ? sum('usefulReads') / sum('reads') : null,
    meanEvidenceCoverage: rows.reduce((n, row) => n + row.score.requiredEvidenceCoverage, 0) / rows.length,
    annotatedCitationPrecision: sum('cited') ? sum('supportedCitations') / sum('cited') : null,
    unsupportedCitations: sum('unsupportedCitations'), modelCalls: sum('modelCalls'),
    promptTokens: sum('promptTokens'), outputTokens: sum('outputTokens'),
    meanDurationMs: rows.reduce((n, row) => n + row.run.durationMs, 0) / rows.length };
}

export async function dialogueSourceHashes() {
  const files: Record<string, string> = {}, seen = new Set<string>();
  async function visit(name: string) {
    if (seen.has(name)) return; seen.add(name);
    const source = await readFile(new URL(`../../src/${name}.ts`, import.meta.url), 'utf8');
    files[`src/${name}.ts`] = sha(source); files[`dist/src/${name}.js`] = sha(await readFile(new URL(name + '.js', import.meta.url)));
    for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+)\.js['"]/g)) await visit(match[1]!);
  }
  await visit('evaluate-investigation-dialogue');
  files['package-lock.json'] = sha(await readFile(new URL('../../package-lock.json', import.meta.url)));
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export async function planDialogueEvaluation(model: string | null, request: typeof fetch = fetch) {
  if (model !== null && model !== 'qwen2.5:3b') throw new Error('This development protocol uses qwen2.5:3b or rules-only');
  let identity: { name: string; digest: string; details: unknown } | null = null, ollama: unknown = null;
  if (model) {
    const tags = await request('http://127.0.0.1:11434/api/tags', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!tags.ok) throw new Error('Cannot verify model identity');
    const installed = (await tags.json()).models?.find((row: { name: string }) => row.name === model);
    if (!installed || !/^[a-f0-9]{64}$/.test(installed.digest ?? '')) throw new Error('Missing model digest');
    identity = { name: model, digest: installed.digest, details: installed.details };
    const version = await request('http://127.0.0.1:11434/api/version', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!version.ok) throw new Error('Cannot verify Ollama version'); ollama = await version.json();
  }
  const cases = dialogueCases();
  return { protocol: 'investigation-dialogue-development-v1', createdAt: new Date().toISOString(), node: process.version,
    model: identity, ollama, options: dialogueOptions, prompt: dialoguePrompt, files: await dialogueSourceHashes(),
    cases, datasetDigest: sha(JSON.stringify(cases)), maxReads: 3, maxDecisions: 4,
    independentReview: false, holdout: false, promotionEligible: false,
    limitation: 'Synthetic paired development cases and single-author annotations. Tool responses are in-memory replay, not live integration. Useful reads are ex-post witness membership, not production information gain. No human ROI or financial authority.' };
}

export async function evaluateDialoguePlan(plan: Awaited<ReturnType<typeof planDialogueEvaluation>>, request: typeof fetch = fetch,
  capture: (row: unknown) => Promise<void> = async () => {}, progress: (message: string) => void = () => {}) {
  if (plan.node !== process.version || JSON.stringify(plan.files) !== JSON.stringify(await dialogueSourceHashes())
    || plan.datasetDigest !== sha(JSON.stringify(dialogueCases())) || plan.datasetDigest !== sha(JSON.stringify(plan.cases))
    || JSON.stringify(plan.options) !== JSON.stringify(dialogueOptions) || plan.prompt !== dialoguePrompt
    || plan.maxReads !== 3 || plan.maxDecisions !== 4) throw new Error('Dialogue plan changed before execution');
  const groups = [];
  for (const method of ['rules', ...(plan.model ? [plan.model.name] : [])]) {
    const cases = [];
    for (const sample of plan.cases) {
      progress(`${method}: ${sample.id}`);
      // Only this closure can access hidden reads. Neither policy receives labels or the fixture ID.
      const run = await runDialogue(sample.initial, async (tool) => structuredClone(sample.hidden[tool]),
        method === 'rules' ? ruleDialoguePolicy : (view) => callDialogueModel(view, method, request));
      const row = { id: sample.id, run, score: scoreDialogue(run, sample.label) };
      cases.push(row); await capture({ method, ...row });
    }
    groups.push({ method, summary: summarizeDialogues(cases), cases });
  }
  return { protocol: plan.protocol, completedAt: new Date().toISOString(), planDigest: sha(JSON.stringify(plan)),
    groups, promotionEligible: false, independentReview: false, limitation: plan.limitation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { model: { type: 'string' }, 'rules-only': { type: 'boolean' }, output: { type: 'string' } } });
  if (!values.output || Boolean(values.model) === Boolean(values['rules-only'])) throw new Error('Specify --output <new.json> and either --model qwen2.5:3b or --rules-only');
  const plan = await planDialogueEvaluation(values.model ?? null);
  const planFile = await open(values.output + '.plan.json', 'wx');
  try { await planFile.writeFile(JSON.stringify(plan, null, 2) + '\n'); } finally { await planFile.close(); }
  const reportFile = await open(values.output, 'wx');
  try {
    const captureFile = await open(values.output + '.cases.jsonl', 'wx');
    try {
      const report = await evaluateDialoguePlan(plan, fetch, async (row) => { await captureFile.writeFile(JSON.stringify(row) + '\n'); await captureFile.sync(); }, console.error);
      await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n');
      console.error(JSON.stringify(report.groups.map(({ method, summary }) => ({ method, summary })), null, 2));
    } finally { await captureFile.close(); }
  } finally { await reportFile.close(); }
}
