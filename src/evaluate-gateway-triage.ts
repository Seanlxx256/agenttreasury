import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gatewayTriageDatasets, type GatewayTriageCase } from './gateway-triage-cases.js';
import {
  prepareGatewayTriage, reviewGatewayTriage, type TriageAction, type TriageRecommendation,
} from './gateway-triage.js';

function needsHumanReview(action: TriageAction | null) {
  return action === 'escalate' || action === 'review-conflict';
}

function score(recommendation: TriageRecommendation | undefined, sample: GatewayTriageCase, elapsedMs: number) {
  const citations = recommendation?.citations ?? [];
  const relevant = new Set([...sample.requiredCitations, ...(sample.optionalCitations ?? [])]);
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
) {
  const cases = [];
  for (const sample of gatewayTriageDatasets[dataset]) {
    const started = performance.now();
    const input = prepareGatewayTriage(sample.purchase, sample.observations);
    const rules = score(input.rules, sample, performance.now() - started);
    const modelStarted = performance.now();
    const { agent } = await reviewGatewayTriage(input, model, request);
    const modelElapsed = performance.now() - modelStarted;
    cases.push({
      name: sample.name,
      expectedAction: sample.expectedAction,
      requiredCitations: sample.requiredCitations,
      allowedActions: input.allowed.map(({ action }) => action),
      expectedActionAllowed: input.allowed.some(({ action }) => action === sample.expectedAction),
      rules,
      agent: model ? {
        status: agent.status,
        ...score(agent.status === 'ready' ? agent.recommendation : undefined, sample, modelElapsed),
      } : null,
    });
  }

  const agentResults = cases.flatMap(({ agent }) => agent ? [agent] : []);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    'rules-only': { type: 'boolean' }, model: { type: 'string' },
    dataset: { type: 'string', default: 'gateway-triage-v1' },
  } });
  const { dataset } = values;
  if (!Object.hasOwn(gatewayTriageDatasets, dataset) || values.model === '' ||
      (values['rules-only'] && values.model !== undefined)) {
    const datasets = Object.keys(gatewayTriageDatasets).join('|');
    throw new Error(`Usage: npm run eval:gateway -- [--dataset ${datasets}] [--rules-only | --model MODEL]`);
  }
  const model = values['rules-only'] ? undefined : (values.model ?? process.env.GATEWAY_TRIAGE_MODEL) || undefined;
  const result = await evaluateGatewayTriage(model, fetch, dataset as Dataset);
  console.log(JSON.stringify(result, null, 2));
  if (result.agent?.recommendations === 0) process.exitCode = 2;
}
