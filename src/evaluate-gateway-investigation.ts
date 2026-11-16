import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gatewayInvestigationCases } from './gateway-investigation-cases.js';
import {
  investigationKinds, suggestInvestigationsRules, suggestInvestigationsWithModel,
  type InvestigationKind, type InvestigationSuggestion,
} from './gateway-investigation.js';

type Scoring = { recall: number | null; precision: number | null; matched: number; expected: number; suggested: number };

export function scoreInvestigation(expected: InvestigationKind[], suggestions: InvestigationSuggestion[]): Scoring {
  const expectedSet = new Set(expected);
  const kinds = [...new Set(suggestions.map(({ kind }) => kind))];
  const matched = kinds.filter((kind) => expectedSet.has(kind)).length;
  return {
    matched,
    expected: expectedSet.size,
    suggested: kinds.length,
    recall: expectedSet.size ? matched / expectedSet.size : null,
    precision: kinds.length ? matched / kinds.length : null,
  };
}

function summarize(rows: Scoring[]): Scoring {
  const expected = rows.reduce((sum, row) => sum + row.expected, 0);
  const suggested = rows.reduce((sum, row) => sum + row.suggested, 0);
  const matched = rows.reduce((sum, row) => sum + row.matched, 0);
  return {
    matched, expected, suggested,
    recall: expected ? matched / expected : null,
    precision: suggested ? matched / suggested : null,
  };
}

const emptyScoring = (expected: number): Scoring =>
  ({ matched: 0, expected, suggested: 0, recall: 0, precision: null });

export async function evaluateGatewayInvestigation(model?: string, request: typeof fetch = fetch) {
  const rulesRows: Scoring[] = [];
  const agentRows: Scoring[] = [];
  const modelOnlyRows: Scoring[] = [];
  const agentStats = { ready: 0, rejected: 0, unavailable: 0 };
  const cases = [];

  for (const sample of gatewayInvestigationCases) {
    const ruleStart = performance.now();
    const rulesSuggestions = suggestInvestigationsRules(sample.facts);
    const ruleDurationMs = performance.now() - ruleStart;
    const rulesScoring = scoreInvestigation(sample.expected, rulesSuggestions);
    rulesRows.push(rulesScoring);

    let agentScoring: Scoring | null = null;
    let agentStatus = 'disabled';
    let agentKinds: InvestigationKind[] = [];
    let modelDurationMs: number | null = null;
    if (model) {
      const modelStart = performance.now();
      const { status, investigations } = await suggestInvestigationsWithModel(sample.facts, model, request);
      modelDurationMs = performance.now() - modelStart;
      agentStatus = status;
      agentKinds = investigations.map(({ kind }) => kind);
      if (status === 'ready') {
        agentScoring = scoreInvestigation(sample.expected, investigations);
        agentStats.ready++;
      } else {
        if (status === 'rejected') agentStats.rejected++;
        if (status === 'unavailable') agentStats.unavailable++;
        // Fallback to the rule checklist so the operator always has a suggestion.
        agentScoring = scoreInvestigation(sample.expected, rulesSuggestions);
      }
    }
    agentRows.push(agentScoring ?? emptyScoring(sample.expected.length));
    modelOnlyRows.push(agentStatus === 'ready' ? agentScoring! : emptyScoring(new Set(sample.expected).size));

    cases.push({
      name: sample.name,
      timing: { ruleDurationMs, modelDurationMs },
      expected: sample.expected,
      rules: { kinds: rulesSuggestions.map(({ kind }) => kind), ...rulesScoring },
      agent: model ? { status: agentStatus, kinds: agentKinds, ...(agentScoring ?? emptyScoring(sample.expected.length)) } : null,
    });
  }

  return {
    dataset: 'gateway-investigation-v1',
    model: model ?? null,
    totalCases: gatewayInvestigationCases.length,
    rules: summarize(rulesRows),
    agent: model ? { ...summarize(agentRows), ...agentStats, modelOnly: summarize(modelOnlyRows),
      scoringBasis: 'Effective suggestions include rule fallback; modelOnly counts only accepted model outputs.' } : null,
    cases,
  };
}

export async function evaluateGatewayInvestigationAcrossModels(models: string[], request: typeof fetch = fetch) {
  const rules = await evaluateGatewayInvestigation(undefined, request);
  const results = [];
  for (const model of models) {
    results.push({ model, result: await evaluateGatewayInvestigation(model, request) });
  }
  const comparison: Record<string, { recall: number | null; precision: number | null }> = {
    rules: { recall: rules.rules.recall, precision: rules.rules.precision },
  };
  for (const { model, result } of results) {
    comparison[model] = { recall: result.agent?.recall ?? null, precision: result.agent?.precision ?? null };
  }
  return { dataset: 'gateway-investigation-v1', rules: rules.rules, comparison, models: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    'rules-only': { type: 'boolean' }, model: { type: 'string' }, models: { type: 'string' },
  } });
  const modelList = (values.models ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (values.model === '' || (values.models !== undefined && modelList.length === 0) ||
      (values.model !== undefined && values.models !== undefined) ||
      (values['rules-only'] && (values.model !== undefined || values.models !== undefined))) {
    throw new Error('Usage: npm run eval:gateway-investigation -- [--rules-only | --model MODEL | --models M1,M2,...]');
  }
  if (values.models !== undefined) {
    console.log(JSON.stringify(await evaluateGatewayInvestigationAcrossModels(modelList), null, 2));
  } else {
    const model = values['rules-only'] ? undefined : (values.model ?? process.env.GATEWAY_TRIAGE_MODEL) || undefined;
    console.log(JSON.stringify(await evaluateGatewayInvestigation(model), null, 2));
  }
}
