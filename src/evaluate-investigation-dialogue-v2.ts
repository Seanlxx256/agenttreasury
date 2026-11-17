import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { dialogueCases } from './investigation-dialogue-cases.js';
import { dialogueOptions, ruleDialoguePolicy, runDialogue } from './investigation-dialogue.js';
import { planDialogueEvaluation, scoreDialogue, summarizeDialogues } from './evaluate-investigation-dialogue.js';
import { callDialogueModelV2, dialoguePromptV2 } from './investigation-dialogue-v2.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function dialogueV2SourceHashes() {
  const files: Record<string, string> = {}, seen = new Set<string>();
  async function visit(name: string) {
    if (seen.has(name)) return; seen.add(name);
    const source = await readFile(new URL(`../../src/${name}.ts`, import.meta.url), 'utf8');
    files[`src/${name}.ts`] = sha(source); files[`dist/src/${name}.js`] = sha(await readFile(new URL(name + '.js', import.meta.url)));
    for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+)\.js['"]/g)) await visit(match[1]!);
  }
  await visit('evaluate-investigation-dialogue-v2');
  files['package-lock.json'] = sha(await readFile(new URL('../../package-lock.json', import.meta.url)));
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
export async function planDialogueV2(model: string | null, request: typeof fetch = fetch) {
  const original = await planDialogueEvaluation(model, request);
  return { ...original, protocol: 'investigation-dialogue-development-v2', prompt: dialoguePromptV2,
    files: await dialogueV2SourceHashes(),
    limitation: original.limitation + ' V2 was developed after observing V1 contract failures on the same cases; this is an in-development protocol repair, not blind model improvement.' };
}
export async function evaluateDialogueV2(plan: Awaited<ReturnType<typeof planDialogueV2>>, request: typeof fetch = fetch,
  capture: (row: unknown) => Promise<void> = async () => {}, progress: (message: string) => void = () => {}) {
  if (plan.node !== process.version || JSON.stringify(plan.files) !== JSON.stringify(await dialogueV2SourceHashes())
    || plan.datasetDigest !== sha(JSON.stringify(dialogueCases())) || plan.datasetDigest !== sha(JSON.stringify(plan.cases))
    || JSON.stringify(plan.options) !== JSON.stringify(dialogueOptions) || plan.prompt !== dialoguePromptV2
    || plan.maxReads !== 3 || plan.maxDecisions !== 4) throw new Error('Dialogue V2 plan changed before execution');
  const groups = [];
  for (const method of ['rules', ...(plan.model ? [plan.model.name] : [])]) {
    const cases = [];
    for (const sample of plan.cases) {
      progress(`${method}: ${sample.id}`);
      const run = await runDialogue(sample.initial, async (tool) => structuredClone(sample.hidden[tool]),
        method === 'rules' ? ruleDialoguePolicy : (view) => callDialogueModelV2(view, method, request));
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
  const plan = await planDialogueV2(values.model ?? null);
  const planFile = await open(values.output + '.plan.json', 'wx');
  try { await planFile.writeFile(JSON.stringify(plan, null, 2) + '\n'); } finally { await planFile.close(); }
  const reportFile = await open(values.output, 'wx');
  try {
    const captureFile = await open(values.output + '.cases.jsonl', 'wx');
    try {
      const report = await evaluateDialogueV2(plan, fetch, async (row) => { await captureFile.writeFile(JSON.stringify(row) + '\n'); await captureFile.sync(); }, console.error);
      await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n');
      console.error(JSON.stringify(report.groups.map(({ method, summary }) => ({ method, summary })), null, 2));
    } finally { await captureFile.close(); }
  } finally { await reportFile.close(); }
}
