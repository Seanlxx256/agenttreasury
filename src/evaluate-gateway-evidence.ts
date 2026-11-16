import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gatewayEvidenceCases } from './gateway-evidence-cases.js';
import { gatewayEvidenceTestCases } from './gateway-evidence-test-cases.js';
import {
  extractEvidenceRules, extractEvidenceWithModel, type EvidenceSignal,
} from './gateway-evidence-extraction.js';

const datasets = {
  'gateway-evidence-v1': gatewayEvidenceCases,
  'gateway-evidence-test-v1': gatewayEvidenceTestCases,
} as const;
type DatasetName = keyof typeof datasets;

type Scoring = { recall: number | null; precision: number | null; matched: number; expected: number; extracted: number };

function score(expected: EvidenceSignal[], extracted: EvidenceSignal[]): Scoring {
  const expectedSet = new Set(expected);
  const matched = extracted.filter((signal) => expectedSet.has(signal)).length;
  return {
    matched,
    expected: expected.length,
    extracted: extracted.length,
    recall: expected.length ? matched / expected.length : null,
    precision: extracted.length ? matched / extracted.length : null,
  };
}

function summarize(rows: Scoring[]): Scoring {
  const expected = rows.reduce((sum, row) => sum + row.expected, 0);
  const extracted = rows.reduce((sum, row) => sum + row.extracted, 0);
  const matched = rows.reduce((sum, row) => sum + row.matched, 0);
  return {
    matched, expected, extracted,
    recall: expected ? matched / expected : null,
    precision: extracted ? matched / extracted : null,
  };
}

const emptyScoring = (expected: number): Scoring =>
  ({ matched: 0, expected, extracted: 0, recall: 0, precision: null });

export async function evaluateGatewayEvidence(
  model?: string, request: typeof fetch = fetch, datasetName: DatasetName = 'gateway-evidence-v1',
) {
  const samples = datasets[datasetName];
  const directRules: Scoring[] = [];
  const paraphraseRules: Scoring[] = [];
  const directAgent: Scoring[] = [];
  const paraphraseAgent: Scoring[] = [];
  const agentStats = { ready: 0, rejected: 0, unavailable: 0 };
  const cases = [];

  for (const sample of samples) {
    const ruleSignals = extractEvidenceRules(sample.text).map(({ signal }) => signal);
    const rulesScoring = score(sample.expected, ruleSignals);
    (sample.paraphrased ? paraphraseRules : directRules).push(rulesScoring);

    let agentScoring: Scoring | null = null;
    let agentSignals: EvidenceSignal[] = [];
    let agentStatus = 'disabled';
    if (model) {
      const { status, signals } = await extractEvidenceWithModel(sample.text, model, request);
      agentStatus = status;
      agentSignals = signals.map(({ signal }) => signal);
      if (status === 'ready') {
        agentScoring = score(sample.expected, agentSignals);
        (sample.paraphrased ? paraphraseAgent : directAgent).push(agentScoring);
        agentStats.ready++;
      } else {
        (sample.paraphrased ? paraphraseAgent : directAgent).push(emptyScoring(sample.expected.length));
        if (status === 'rejected') agentStats.rejected++;
        if (status === 'unavailable') agentStats.unavailable++;
      }
    }

    cases.push({
      name: sample.name,
      paraphrased: sample.paraphrased,
      expected: sample.expected,
      rules: { signals: ruleSignals, ...rulesScoring },
      agent: model ? { status: agentStatus, signals: agentSignals, ...(agentScoring ?? emptyScoring(sample.expected.length)) } : null,
    });
  }

  const allRules = [...directRules, ...paraphraseRules];
  const allAgent = [...directAgent, ...paraphraseAgent];
  return {
    dataset: datasetName,
    model: model ?? null,
    totalCases: samples.length,
    rules: summarize(allRules),
    agent: model ? { ...summarize(allAgent), ...agentStats } : null,
    byPhrasing: {
      direct: {
        cases: directRules.length,
        rules: summarize(directRules),
        agent: model ? summarize(directAgent) : null,
      },
      paraphrased: {
        cases: paraphraseRules.length,
        rules: summarize(paraphraseRules),
        agent: model ? summarize(paraphraseAgent) : null,
      },
    },
    cases,
  };
}

export async function evaluateGatewayEvidenceAcrossModels(
  models: string[], request: typeof fetch = fetch, datasetName: DatasetName = 'gateway-evidence-v1',
) {
  const rules = await evaluateGatewayEvidence(undefined, request, datasetName);
  const results = [];
  for (const model of models) {
    results.push({ model, result: await evaluateGatewayEvidence(model, request, datasetName) });
  }
  const comparison: Record<string, { recall: number | null; precision: number | null }> = {
    rules: { recall: rules.rules.recall, precision: rules.rules.precision },
  };
  for (const { model, result } of results) {
    comparison[model] = { recall: result.agent?.recall ?? null, precision: result.agent?.precision ?? null };
  }
  return { dataset: datasetName, rules: rules.rules, comparison, models: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    'rules-only': { type: 'boolean' }, model: { type: 'string' }, models: { type: 'string' },
    dataset: { type: 'string' },
  } });
  const datasetName = (values.dataset ?? 'gateway-evidence-v1') as DatasetName;
  if (!(datasetName in datasets)) {
    throw new Error(`Unknown dataset. Choose one of: ${Object.keys(datasets).join(', ')}`);
  }
  const modelList = (values.models ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (values.model === '' || (values.models !== undefined && modelList.length === 0) ||
      (values.model !== undefined && values.models !== undefined) ||
      (values['rules-only'] && (values.model !== undefined || values.models !== undefined))) {
    throw new Error('Usage: npm run eval:gateway-evidence -- [--rules-only | --model MODEL | --models M1,M2,...] [--dataset NAME]');
  }
  if (values.models !== undefined) {
    console.log(JSON.stringify(await evaluateGatewayEvidenceAcrossModels(modelList, fetch, datasetName), null, 2));
  } else {
    const model = values['rules-only'] ? undefined : (values.model ?? process.env.GATEWAY_TRIAGE_MODEL) || undefined;
    console.log(JSON.stringify(await evaluateGatewayEvidence(model, fetch, datasetName), null, 2));
  }
}
