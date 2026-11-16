import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gatewayTriageDatasets, type GatewayTriageCase } from './gateway-triage-cases.js';
import {
  prepareGatewayTriage, reviewGatewayTriage, type TriageAction, type TriageRecommendation,
} from './gateway-triage.js';
import { resolveTriageModelProfile } from './gateway-triage-models.js';

function needsHumanReview(action: TriageAction | null) {
  return action === 'escalate' || action === 'review-conflict';
}

function score(recommendation: TriageRecommendation | undefined, sample: GatewayTriageCase, elapsedMs: number) {
  const citations = recommendation?.citations ?? [];
  const relevant = new Set([...sample.requiredCitations, ...(sample.optionalCitations ?? []), ...(sample.criticalEvidence ?? [])]);
  const supported = citations.filter((id) => relevant.has(id)).length;
  return {
    action: recommendation?.action ?? null,
    rationale: recommendation?.rationale ?? null,
    citations,
    actionCorrect: recommendation?.action === sample.expectedAction,
    humanReviewExpected: needsHumanReview(sample.expectedAction),
    citationsCorrect: supported === citations.length && sample.requiredCitations.every((id) => citations.includes(id)),
    supportedCitations: supported,
    elapsedMs,
  };
}

function scoreCriticalEvidence(citations: string[], sample: GatewayTriageCase) {
  const critical = sample.criticalEvidence ?? [];
  const relevant = new Set([...sample.requiredCitations, ...(sample.optionalCitations ?? []), ...critical]);
  return {
    expected: critical.length,
    hits: critical.filter((id) => citations.includes(id)).length,
    unrelated: citations.filter((id) => !relevant.has(id)).length,
  };
}

function summarizeCriticalEvidence(rows: ReturnType<typeof scoreCriticalEvidence>[]) {
  const expected = rows.reduce((total, row) => total + row.expected, 0);
  const hits = rows.reduce((total, row) => total + row.hits, 0);
  return { expected, hits, recall: expected ? hits / expected : null,
    unrelated: rows.reduce((total, row) => total + row.unrelated, 0) };
}

function summarize(results: ReturnType<typeof score>[]) {
  const cases = results.length;
  const recommendations = results.filter(({ action }) => action !== null).length;
  const correctActions = results.filter(({ actionCorrect }) => actionCorrect).length;
  const correctCitationSets = results.filter(({ citationsCorrect }) => citationsCorrect).length;
  const escalations = results.filter(({ action }) => needsHumanReview(action)).length;
  const casesWithoutExpectedHumanReview = results.filter(({ humanReviewExpected }) => !humanReviewExpected).length;
  const unnecessaryEscalations = results.filter(({ action, humanReviewExpected }) =>
    !humanReviewExpected && needsHumanReview(action)).length;
  const citations = results.reduce((count, row) => count + row.citations.length, 0);
  const supported = results.reduce((count, row) => count + row.supportedCitations, 0);
  return {
    cases, recommendations, correctActions, correctCitationSets, escalations,
    casesWithoutExpectedHumanReview, unnecessaryEscalations,
    unnecessaryEscalationRate: casesWithoutExpectedHumanReview ? unnecessaryEscalations / casesWithoutExpectedHumanReview : null,
    actionAccuracy: cases ? correctActions / cases : null,
    recommendationCoverage: cases ? recommendations / cases : null,
    citationPrecision: citations ? supported / citations : null,
    escalationRecommendationRate: recommendations ? escalations / recommendations : null,
    meanGenerationMs: cases ? results.reduce((total, { elapsedMs }) => total + elapsedMs, 0) / cases : null,
  };
}

type Dataset = keyof typeof gatewayTriageDatasets;

export async function evaluateGatewayTriage(
  model?: string, request: typeof fetch = fetch, dataset: Dataset = 'gateway-triage-v1',
  mode: 'choose-action' | 'support-rules' = 'choose-action',
) {
  const cases = [];
  for (const sample of gatewayTriageDatasets[dataset]) {
    const started = performance.now();
    const input = prepareGatewayTriage(sample.purchase, sample.observations);
    const rules = score(input.rules, sample, performance.now() - started);
    const modelStarted = performance.now();
    const { agent } = await reviewGatewayTriage(input, model, request, mode);
    const modelElapsed = performance.now() - modelStarted;
    const extra = agent.status === 'ready' ? agent.recommendation.citations.filter((id) => !rules.citations.includes(id)) : [];
    const relevant = [...sample.requiredCitations, ...(sample.optionalCitations ?? []), ...(sample.criticalEvidence ?? [])];
    cases.push({
      name: sample.name,
      expectedAction: sample.expectedAction,
      requiredCitations: sample.requiredCitations,
      allowedActions: input.allowed.map(({ action }) => action),
      expectedActionAllowed: input.allowed.some(({ action }) => action === sample.expectedAction),
      rules,
      ...(mode === 'support-rules' ? { extraEvidence: extra.map((id) => ({ id, relevant: relevant.includes(id) })) } : {}),
      ...(mode === 'support-rules' && sample.criticalEvidence ? { criticalEvidence: {
        targets: sample.criticalEvidence,
        rules: scoreCriticalEvidence(rules.citations, sample),
        assisted: model ? scoreCriticalEvidence([...rules.citations, ...extra], sample) : null,
      } } : {}),
      agent: model ? {
        status: agent.status,
        ...score(agent.status === 'ready' ? agent.recommendation : undefined, sample, modelElapsed),
      } : null,
    });
  }

  const agentResults = cases.flatMap(({ agent }) => agent ? [agent] : []);
  const extraEvidence = cases.flatMap(({ extraEvidence }) => extraEvidence ?? []);
  const criticalCases = cases.flatMap(({ criticalEvidence }) => criticalEvidence ? [criticalEvidence] : []);
  const withChoice = cases.filter(({ allowedActions }) => allowedActions.length > 1);
  const withoutChoice = cases.filter(({ allowedActions }) => allowedActions.length === 1);
  const summarizeGroup = (group: typeof withChoice) => ({
    rules: summarize(group.map(({ rules }) => rules)),
    agent: model ? summarize(group.flatMap(({ agent }) => agent ? [agent] : [])) : null,
    agentWithRuleFallback: model ? summarize(group.map(({ rules, agent }) => {
      if (!agent) return rules;
      const displayed = agent.status === 'ready' ? agent : rules;
      return { ...displayed, elapsedMs: agent.elapsedMs + rules.elapsedMs };
    })) : null,
  });
  return {
    dataset,
    model: model ?? null,
    mode,
    ...(criticalCases.length ? { criticalEvidence: {
      rules: summarizeCriticalEvidence(criticalCases.map(({ rules }) => rules)),
      assisted: model ? summarizeCriticalEvidence(criticalCases.flatMap(({ assisted }) => assisted ? [assisted] : [])) : null,
    } } : {}),
    ...(mode === 'support-rules' ? { supplementalEvidence: {
      selected: extraEvidence.length,
      relevant: extraEvidence.filter(({ relevant }) => relevant).length,
      casesWithRelevantEvidence: cases.filter(({ extraEvidence }) => extraEvidence?.some(({ relevant }) => relevant)).length,
    } } : {}),
    rules: summarize(cases.map(({ rules }) => rules)),
    agent: model ? {
      ...summarize(agentResults),
      rejected: agentResults.filter(({ status }) => status === 'rejected').length,
      unavailable: agentResults.filter(({ status }) => status === 'unavailable').length,
    } : null,
    byActionChoice: {
      multipleActions: summarizeGroup(withChoice),
      singleAction: summarizeGroup(withoutChoice),
    },
    cases,
  };
}

// Run the same dataset against several models and report a side-by-side
// comparison. Models are evaluated serially so a local Ollama never loads
// several weights at once.
export async function evaluateGatewayTriageAcrossModels(
  models: string[], request: typeof fetch = fetch,
  dataset: Dataset = 'gateway-triage-v1', mode: 'choose-action' | 'support-rules' = 'choose-action',
) {
  const rules = await evaluateGatewayTriage(undefined, request, dataset, mode);
  const results = [];
  for (const model of models) {
    const result = await evaluateGatewayTriage(model, request, dataset, mode);
    const profile = resolveTriageModelProfile(model);
    results.push({
      model,
      profile: profile.name === model ? profile.name : `${profile.name} (fallback)`,
      result,
    });
  }
  const summarizeRow = (summary: ReturnType<typeof summarize>) => ({
    actionAccuracy: summary.actionAccuracy,
    correctCitationSets: summary.correctCitationSets,
    citationPrecision: summary.citationPrecision,
    recommendationCoverage: summary.recommendationCoverage,
    unnecessaryEscalationRate: summary.unnecessaryEscalationRate,
    meanGenerationMs: summary.meanGenerationMs,
  });
  const comparison: Record<string, ReturnType<typeof summarizeRow>> = {
    rules: summarizeRow(rules.rules),
  };
  for (const { model, result } of results) comparison[model] = summarizeRow(result.agent ?? rules.rules);
  return {
    dataset,
    mode,
    rules: rules.rules,
    comparison,
    models: results.map(({ model, profile, result }) => ({
      model, profile,
      agent: result.agent,
      rejected: result.agent?.rejected ?? 0,
      unavailable: result.agent?.unavailable ?? 0,
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    'rules-only': { type: 'boolean' }, 'support-rules': { type: 'boolean' }, model: { type: 'string' },
    models: { type: 'string' }, dataset: { type: 'string', default: 'gateway-triage-v1' },
  } });
  const { dataset } = values;
  const modelList = (values.models ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (!Object.hasOwn(gatewayTriageDatasets, dataset) || values.model === '' ||
      (values.models !== undefined && modelList.length === 0) ||
      (values.model !== undefined && values.models !== undefined) ||
      (values['rules-only'] && (values.model !== undefined || values.models !== undefined))) {
    const datasets = Object.keys(gatewayTriageDatasets).join('|');
    throw new Error(`Usage: npm run eval:gateway -- [--dataset ${datasets}] [--support-rules] [--rules-only | --model MODEL | --models M1,M2,...]`);
  }
  const mode = values['support-rules'] ? 'support-rules' as const : 'choose-action' as const;
  if (values.models !== undefined) {
    const result = await evaluateGatewayTriageAcrossModels(modelList, fetch, dataset as Dataset, mode);
    console.log(JSON.stringify(result, null, 2));
    if (result.models.length && result.models.every(({ agent }) => !agent || agent.recommendations === 0)) process.exitCode = 2;
  } else {
    const model = values['rules-only'] ? undefined : (values.model ?? process.env.GATEWAY_TRIAGE_MODEL) || undefined;
    const result = await evaluateGatewayTriage(model, fetch, dataset as Dataset, mode);
    console.log(JSON.stringify(result, null, 2));
    if (result.agent?.recommendations === 0) process.exitCode = 2;
  }
}
