import { open } from 'node:fs/promises';
import { interpretStructuredClaims, type PacketInterpretation } from './gateway-claim-assessment.js';
import { interpretPacketClaims, packetRuleIssues, statementSources } from './gateway-case-packet.js';
import { reviewPacketContext } from './gateway-case-packet-context.js';
import { extractClaimMaterials } from './gateway-claim-materials.js';
import { scoreReviewedClaims, scoreAssertionStates, scoreReviewedMaterials, wilson95, type ReviewedClaimCase } from './claim-comparison-scoring.js';
import { digest } from './claim-review.js';

export const comparisonMethods = ['context-rules', 'legacy-model', 'structured-model'] as const;
export type ComparisonMethod = typeof comparisonMethods[number];
export type ArmResult = Awaited<ReturnType<typeof evaluateClaimArm>>;

// Generic engine for offline synthetic tests. The public CLI adds the reviewed
// dataset and immutable-plan gates; it exposes no bypass or fixture mode.
export async function evaluateClaimArm(sample: ReviewedClaimCase, method: ComparisonMethod, model: string, request: typeof fetch) {
  const start = performance.now(), sources = statementSources(sample.input), rules = packetRuleIssues(sources);
  let interpretation: PacketInterpretation | null = null;
  if (method !== 'context-rules') interpretation = method === 'legacy-model'
    ? await interpretPacketClaims(sources, model, request) : await interpretStructuredClaims(sources, model, request);
  const status = interpretation?.status ?? 'ready';
  const context = reviewPacketContext(sources, rules, interpretation ?? { status: 'disabled', issues: [] });
  const issues = interpretation?.issues ?? context.eligibleIssues;
  const score = scoreReviewedClaims(sample, issues, status === 'ready');
  const workflowScore = scoreReviewedClaims(sample, context.eligibleIssues, true);
  const result = { caseId: sample.id, method, status, interpretation, score,
    stateScore: method === 'structured-model' ? scoreAssertionStates(sample, interpretation?.assessment?.claims ?? [], status === 'ready') : null,
    modelMaterialScore: method === 'structured-model' ? scoreReviewedMaterials(sample, interpretation?.assessment?.materials ?? [], status === 'ready') : null,
    deterministicMaterials: method === 'context-rules' ? scoreReviewedMaterials(sample, extractClaimMaterials(sources)) : null,
    workflow: { score: workflowScore, reviewRequired: context.needsOperatorReview,
      usedRuleFallback: method !== 'context-rules' && status !== 'ready',
      supportedWithoutReview: status === 'ready' && workflowScore.supportedExact && !context.needsOperatorReview,
      context },
  };
  return { ...result, durationMs: performance.now() - start };
}

export async function compareClaimCases(cases: ReviewedClaimCase[], model: string, request: typeof fetch,
  hooks: { verify: () => Promise<void>; capture: (row: ArmResult) => Promise<void> }) {
  const rows: ArmResult[] = [];
  if (!cases.length || new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('Nonempty unique case set required');
  for (const [index, sample] of cases.entries()) {
    const order: ComparisonMethod[] = index % 2 === 0 ? [...comparisonMethods] : ['context-rules', 'structured-model', 'legacy-model'];
    for (const method of order) {
      await hooks.verify();
      const row = await evaluateClaimArm(structuredClone(sample), method, model, request);
      // Persist even if the post-call identity check fails. Such a journal does
      // not become a completed report; its row precedes an explicit abort event.
      await hooks.capture(row); rows.push(row);
      await hooks.verify();
    }
  }
  return rows;
}

export function summarizeClaimComparison(rows: ArmResult[], caseIds: string[]) {
  if (!caseIds.length || rows.length !== caseIds.length * comparisonMethods.length || new Set(caseIds).size !== caseIds.length
    || caseIds.some((id) => comparisonMethods.some((method) => rows.filter((r) => r.caseId === id && r.method === method).length !== 1)))
    throw new Error('Cannot summarize partial, duplicate or foreign results');
  const sum = (group: ArmResult[], value: (r: ArmResult) => number) => group.reduce((n, r) => n + value(r), 0);
  const groups = comparisonMethods.map((method) => {
    const group = rows.filter((r) => r.method === method), attempted = group.length;
    const exact = group.filter((r) => r.score.exact).length, supported = group.filter((r) => r.score.supportedExact).length;
    const sorted = group.map((r) => r.durationMs).sort((a, b) => a - b);
    return { method, attempted, statuses: Object.fromEntries(['ready', 'disabled', 'rejected', 'unavailable'].map((s) => [s, group.filter((r) => r.status === s).length])),
      exact, exactRate: exact / attempted, exactWilson95: wilson95(exact, attempted), supportedExact: supported,
      supportedRate: supported / attempted, supportedWilson95: wilson95(supported, attempted),
      truePositives: sum(group, (r) => r.score.truePositives), falsePositives: sum(group, (r) => r.score.falsePositives),
      falseNegatives: sum(group, (r) => r.score.falseNegatives), unsupportedQuotes: sum(group, (r) => r.score.unsupported),
      reviewRequired: group.filter((r) => r.workflow.reviewRequired).length,
      supportedWithoutReview: group.filter((r) => r.workflow.supportedWithoutReview).length,
      fallbackCases: group.filter((r) => r.workflow.usedRuleFallback).length,
      latencyMs: { total: sum(group, (r) => r.durationMs), p50: sorted[Math.ceil(attempted * .5) - 1], p95: sorted[Math.ceil(attempted * .95) - 1] },
      tokens: { reportedInput: sum(group, (r) => r.interpretation?.diagnostics.promptTokens ?? 0),
        reportedOutput: sum(group, (r) => r.interpretation?.diagnostics.outputTokens ?? 0),
        missingUsageAttempts: method === 'context-rules' ? 0 : group.filter((r) => r.interpretation?.diagnostics.promptTokens == null || r.interpretation?.diagnostics.outputTokens == null).length },
      assertionStates: method === 'structured-model' ? { exact: group.filter((r) => r.stateScore?.exact).length,
        supportedExact: group.filter((r) => r.stateScore?.supportedExact).length } : null,
      rawModelMaterials: method === 'structured-model' ? { found: sum(group, (r) => r.modelMaterialScore!.found), missed: sum(group, (r) => r.modelMaterialScore!.missed), unsupported: sum(group, (r) => r.modelMaterialScore!.unsupported) } : null,
    };
  });
  const controls = rows.filter((r) => r.method === 'context-rules');
  return { cases: caseIds.length, groups,
    deterministicMaterials: { found: sum(controls, (r) => r.deterministicMaterials!.found), missed: sum(controls, (r) => r.deterministicMaterials!.missed),
      unsupported: sum(controls, (r) => r.deterministicMaterials!.unsupported), attribution: 'shared parser, not model improvement' },
    pairedAgainstRules: comparisonMethods.slice(1).map((method) => {
      const pairs = caseIds.map((id) => ({ baseline: rows.find((r) => r.caseId === id && r.method === 'context-rules')!.score.supportedExact,
        candidate: rows.find((r) => r.caseId === id && r.method === method)!.score.supportedExact }));
      return { method, improved: pairs.filter((p) => !p.baseline && p.candidate).length, regressed: pairs.filter((p) => p.baseline && !p.candidate).length,
        unchanged: pairs.filter((p) => p.baseline === p.candidate).length };
    }), promotionEligible: false, humanEfficiencyMeasured: false };
}

export async function captureClaimComparison(output: string, plan: object, job: (capture: (row: ArmResult) => Promise<void>) => Promise<ArmResult[]>, caseIds: string[]) {
  const final = await open(output, 'wx');
  let snapshot: Awaited<ReturnType<typeof open>> | undefined, journal: Awaited<ReturnType<typeof open>> | undefined;
  try {
    snapshot = await open(output + '.plan.json', 'wx'); journal = await open(output + '.cases.jsonl', 'wx');
    const planText = JSON.stringify(plan, null, 2) + '\n', planDigest = digest(planText);
    await snapshot.writeFile(planText); await snapshot.sync();
    await journal.writeFile(JSON.stringify({ event: 'started', planDigest }) + '\n'); await journal.sync();
    const captured: string[] = [];
    const rows = await job(async (row) => {
      const serialized = JSON.stringify(row);
      await journal!.writeFile(JSON.stringify({ event: 'arm-completed', ...row }) + '\n'); await journal!.sync();
      captured.push(serialized);
    });
    if (JSON.stringify(captured) !== JSON.stringify(rows.map((row) => JSON.stringify(row)))) throw new Error('Final rows differ from captured journal');
    const report = { status: 'complete', planDigest, plan, finishedAt: new Date().toISOString(), independentReview: false,
      blindingVerified: false, financialAuthority: false, summary: summarizeClaimComparison(rows, caseIds), rows };
    await final.writeFile(JSON.stringify(report, null, 2) + '\n'); await final.sync(); return report;
  } catch (error) {
    if (journal) { try { await journal.writeFile(JSON.stringify({ event: 'aborted', reason: 'run-or-identity-check-failed', at: new Date().toISOString() }) + '\n'); await journal.sync(); } catch { /* Preserve original failure. */ } }
    throw error;
  } finally { await final.close(); await snapshot?.close(); await journal?.close(); }
}
