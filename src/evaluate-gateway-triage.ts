import { pathToFileURL } from 'node:url';
import { gatewayTriageCases, type GatewayTriageCase } from './gateway-triage-cases.js';
import {
  prepareGatewayTriage, reviewGatewayTriage, type TriageRecommendation,
} from './gateway-triage.js';

function score(recommendation: TriageRecommendation | undefined, sample: GatewayTriageCase, elapsedMs: number) {
  const citations = recommendation?.citations ?? [];
  const relevant = new Set([...sample.requiredCitations, ...(sample.optionalCitations ?? [])]);
  const supported = citations.filter((id) => relevant.has(id)).length;
  return {
    action: recommendation?.action ?? null,
    rationale: recommendation?.rationale ?? null,
    citations,
    actionCorrect: recommendation?.action === sample.expectedAction,
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
  const escalations = results.filter(({ action }) => action === 'escalate' || action === 'review-conflict').length;
  const citations = results.reduce((count, row) => count + row.citations.length, 0);
  const supported = results.reduce((count, row) => count + row.supportedCitations, 0);
  return {
    cases, recommendations, correctActions, correctCitationSets, escalations,
    actionAccuracy: correctActions / cases,
    recommendationCoverage: recommendations / cases,
    citationPrecision: citations ? supported / citations : null,
    escalationRecommendationRate: recommendations ? escalations / recommendations : null,
    meanGenerationMs: results.reduce((total, { elapsedMs }) => total + elapsedMs, 0) / cases,
  };
}

export async function evaluateGatewayTriage(model?: string, request: typeof fetch = fetch) {
  const cases = [];
  for (const sample of gatewayTriageCases) {
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
      expectedActionAllowed: input.allowed.some(({ action }) => action === sample.expectedAction),
      rules,
      agent: model ? {
        status: agent.status,
        ...score(agent.status === 'ready' ? agent.recommendation : undefined, sample, modelElapsed),
      } : null,
    });
  }

  const agentResults = cases.flatMap(({ agent }) => agent ? [agent] : []);
  return {
    dataset: 'gateway-triage-v1',
    model: model ?? null,
    rules: summarize(cases.map(({ rules }) => rules)),
    agent: model ? {
      ...summarize(agentResults),
      rejected: agentResults.filter(({ status }) => status === 'rejected').length,
      unavailable: agentResults.filter(({ status }) => status === 'unavailable').length,
    } : null,
    cases,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === '--rules-only') &&
      !(args.length === 2 && args[0] === '--model' && args[1] && !args[1].startsWith('--'))) {
    throw new Error('Usage: npm run eval:gateway -- [--rules-only | --model MODEL]');
  }
  const model = args[0] === '--rules-only' ? undefined : (args[1] ?? process.env.GATEWAY_TRIAGE_MODEL) || undefined;
  const result = await evaluateGatewayTriage(model);
  console.log(JSON.stringify(result, null, 2));
  if (result.agent?.recommendations === 0) process.exitCode = 2;
}
