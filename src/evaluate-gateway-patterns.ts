import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gatewayPatternBatches } from './gateway-patterns-cases.js';
import { recognizePatternsRules, recognizePatternsWithModel, type SystemicPattern } from './gateway-patterns.js';

export async function evaluateGatewayPatterns(model?: string, request: typeof fetch = fetch) {
  const cases = [];
  let rulesCorrect = 0;
  let agentCorrect = 0;
  const agentStats = { ready: 0, rejected: 0, unavailable: 0 };

  for (const batch of gatewayPatternBatches) {
    const rulesPattern = recognizePatternsRules(batch.cases);
    const rulesHit = rulesPattern === batch.expected;
    if (rulesHit) rulesCorrect++;

    let agentPattern: SystemicPattern | null = null;
    let agentStatus = 'disabled';
    if (model) {
      const { status, pattern } = await recognizePatternsWithModel(batch.cases, model, request);
      agentStatus = status;
      agentPattern = pattern;
      if (status === 'ready') agentStats.ready++;
      else if (status === 'rejected') agentStats.rejected++;
      else agentStats.unavailable++;
      if (pattern === batch.expected) agentCorrect++;
    }

    cases.push({
      name: batch.name,
      expected: batch.expected,
      rules: { pattern: rulesPattern, correct: rulesHit },
      agent: model ? { status: agentStatus, pattern: agentPattern, correct: agentPattern === batch.expected } : null,
    });
  }

  const total = gatewayPatternBatches.length;
  return {
    dataset: 'gateway-patterns-v1',
    model: model ?? null,
    totalBatches: total,
    rules: { correct: rulesCorrect, total, accuracy: rulesCorrect / total },
    agent: model ? { correct: agentCorrect, total, accuracy: agentCorrect / total, ...agentStats } : null,
    cases,
  };
}

export async function evaluateGatewayPatternsAcrossModels(models: string[], request: typeof fetch = fetch) {
  const rules = await evaluateGatewayPatterns(undefined, request);
  const results = [];
  for (const model of models) {
    results.push({ model, result: await evaluateGatewayPatterns(model, request) });
  }
  const comparison: Record<string, { accuracy: number | null }> = {
    rules: { accuracy: rules.rules.accuracy },
  };
  for (const { model, result } of results) {
    comparison[model] = { accuracy: result.agent?.accuracy ?? null };
  }
  return { dataset: 'gateway-patterns-v1', rules: rules.rules, comparison, models: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    'rules-only': { type: 'boolean' }, model: { type: 'string' }, models: { type: 'string' },
  } });
  const modelList = (values.models ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (values.model === '' || (values.models !== undefined && modelList.length === 0) ||
      (values.model !== undefined && values.models !== undefined) ||
      (values['rules-only'] && (values.model !== undefined || values.models !== undefined))) {
    throw new Error('Usage: npm run eval:gateway-patterns -- [--rules-only | --model MODEL | --models M1,M2,...]');
  }
  if (values.models !== undefined) {
    console.log(JSON.stringify(await evaluateGatewayPatternsAcrossModels(modelList), null, 2));
  } else {
    const model = values['rules-only'] ? undefined : (values.model ?? process.env.GATEWAY_TRIAGE_MODEL) || undefined;
    console.log(JSON.stringify(await evaluateGatewayPatterns(model), null, 2));
  }
}
