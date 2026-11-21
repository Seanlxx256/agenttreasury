import { readFile, open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { digest, readBoundedReview, freezeClaimReview } from './claim-review.js';
import { packetInterpretationPrompt, packetInterpretationOptions } from './gateway-case-packet.js';
import { claimAssessmentPrompt, structuredClaimOptions } from './gateway-claim-assessment.js';
import { claimScoringProtocol } from './claim-comparison-scoring.js';
import { compareClaimCases, captureClaimComparison, comparisonMethods } from './claim-comparison.js';

const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) <= Date.now();
const modelName = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_.:/-]{0,127}$/i.test(value);

export async function verifyFrozenClaimLabels(labelsPath: string, reviewPath: string) {
  const [labels, review] = await Promise.all([readBoundedReview(labelsPath), readBoundedReview(reviewPath)]);
  const expected = await freezeClaimReview(review.value);
  const candidate = labels.value as { frozenAt?: unknown } | null;
  if (!candidate || !timestamp(candidate.frozenAt) || Date.parse(candidate.frozenAt) < Date.parse(expected.reviewer.reviewedAt)) throw new Error('Invalid label freeze timestamp');
  const canonical = { ...expected, frozenAt: candidate.frozenAt, sourceFileDigest: review.digest };
  if (!isDeepStrictEqual(labels.value, canonical)) throw new Error('Frozen labels differ from original review, corpus or provenance');
  return { freeze: canonical, labelsFileDigest: labels.digest, reviewFileDigest: review.digest };
}

export async function frozenClaimEvaluationFiles() {
  const files: Record<string, string> = {}, visited = new Set<string>();
  async function visit(name: string) {
    if (visited.has(name)) return; visited.add(name);
    const source = await readFile(new URL(`../../src/${name}.ts`, import.meta.url), 'utf8');
    files[`src/${name}.ts`] = digest(source); files[`dist/src/${name}.js`] = digest(await readFile(new URL(`${name}.js`, import.meta.url)));
    for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+)\.js['"]/g)) await visit(match[1]!);
  }
  await visit('frozen-claim-evaluation-cli');
  for (const path of ['package-lock.json', 'benchmarks/claim-review-v1/manifest.json', 'benchmarks/claim-review-v1/inputs.json', 'benchmarks/claim-review-v1/author-labels.json']) {
    files[path] = digest(await readFile(new URL('../../' + path, import.meta.url)));
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

async function metadata(path: 'tags' | 'version', request: typeof fetch) {
  const response = await request(`http://127.0.0.1:11434/api/${path}`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Ollama metadata unavailable'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing Ollama metadata body');
  let length = 0; const chunks: Uint8Array[] = [];
  try { while (true) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.length; if (length > 65536) { await reader.cancel(); throw new Error('Ollama metadata too large'); }
    chunks.push(value);
  } } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function claimRuntimeIdentity(name: string, request: typeof fetch = fetch) {
  if (!modelName(name)) throw new Error('Invalid installed model name');
  const [tags, version] = await Promise.all([metadata('tags', request), metadata('version', request)]);
  const installed = Array.isArray(tags.models) ? tags.models.filter((m: { name?: unknown }) => m?.name === name) : [];
  if (installed.length !== 1 || !/^[0-9a-f]{64}$/i.test(installed[0]?.digest ?? '')) throw new Error('Exactly one installed model with a SHA-256 digest is required');
  if (typeof version.version !== 'string' || !version.version.trim() || version.version.length > 100) throw new Error('Ollama version unavailable');
  return { model: { name, digest: String(installed[0].digest) }, ollamaVersion: version.version as string,
    node: process.version, platform: process.platform, arch: process.arch };
}
type VerifiedLabels = Awaited<ReturnType<typeof verifyFrozenClaimLabels>>;
type Runtime = Awaited<ReturnType<typeof claimRuntimeIdentity>>;

function planBody(labels: VerifiedLabels, runtime: Runtime, files: Record<string, string>, createdAt: string) {
  return { protocol: 'frozen-reviewed-claims-v1', createdAt, status: 'labels-validated-runtime-pinned', runtime, files,
    labelsFileDigest: labels.labelsFileDigest, originalReviewFileDigest: labels.reviewFileDigest,
    datasetId: labels.freeze.datasetId, inputDigest: labels.freeze.inputDigest, annotationDigest: labels.freeze.annotationDigest,
    labelsFrozenAt: labels.freeze.frozenAt, reviewer: labels.freeze.reviewer, cases: labels.freeze.cases,
    contract: { methods: comparisonMethods, order: 'rules first; legacy/structured alternate by case index; serial execution',
      prompts: { legacy: packetInterpretationPrompt, structured: claimAssessmentPrompt },
      options: { legacy: packetInterpretationOptions, structured: structuredClaimOptions },
      timeoutMsPerModelCall: 30000, responseLimitBytes: 65536, scoring: claimScoringProtocol,
      attempts: 'one per method per case; no retries, sampling, automatic resume or label-based filtering' },
    independentReview: false, blindingVerified: false, promotionEligible: false, financialAuthority: false,
    limitation: 'External review and blinding remain declarations. Synthetic cases may be correlated. This evaluates advisory extraction and context gating, not operational ROI, human time or production accuracy.' };
}
export type FrozenClaimPlan = ReturnType<typeof planBody>;

export async function planFrozenClaimEvaluation(labelsPath: string, reviewPath: string, model: string, request: typeof fetch = fetch) {
  // No model metadata or inference before review and freeze gates pass.
  const labels = await verifyFrozenClaimLabels(labelsPath, reviewPath);
  const files = await frozenClaimEvaluationFiles();
  const runtime = await claimRuntimeIdentity(model, request);
  const plan = planBody(labels, runtime, files, new Date().toISOString());
  await verifyFrozenClaimPlan(plan, labelsPath, reviewPath, request);
  return plan;
}

export async function verifyFrozenClaimPlan(value: unknown, labelsPath: string, reviewPath: string, request: typeof fetch = fetch): Promise<FrozenClaimPlan> {
  const labels = await verifyFrozenClaimLabels(labelsPath, reviewPath);
  const plan = value as FrozenClaimPlan | null;
  if (!plan || !timestamp(plan.createdAt) || Date.parse(plan.createdAt) < Date.parse(labels.freeze.frozenAt) || !modelName(plan.runtime?.model?.name)) throw new Error('Invalid evaluation plan');
  const expected = planBody(labels, plan.runtime, await frozenClaimEvaluationFiles(), plan.createdAt);
  if (!isDeepStrictEqual(value, expected)) throw new Error('Evaluation plan, labels, prompts, scoring or source files changed');
  if (!isDeepStrictEqual(plan.runtime, await claimRuntimeIdentity(plan.runtime.model.name, request))) throw new Error('Model or runtime changed after planning');
  return structuredClone(expected);
}

export async function writeClaimPlan(output: string, plan: FrozenClaimPlan) {
  const file = await open(output, 'wx');
  try { await file.writeFile(JSON.stringify(plan, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
}

export async function runFrozenClaimEvaluation(planPath: string, labelsPath: string, reviewPath: string, output: string, request: typeof fetch = fetch) {
  const originalPlan = await readBoundedReview(planPath);
  const plan = await verifyFrozenClaimPlan(originalPlan.value, labelsPath, reviewPath, request);
  const verify = async () => {
    const current = await readBoundedReview(planPath);
    if (current.digest !== originalPlan.digest) throw new Error('Plan file changed during evaluation');
    await verifyFrozenClaimPlan(current.value, labelsPath, reviewPath, request);
  };
  return captureClaimComparison(output, plan, async (capture) => {
    const rows = await compareClaimCases(plan.cases, plan.runtime.model.name, request, { verify, capture });
    await verify(); return rows;
  }, plan.cases.map((c) => c.id));
}
