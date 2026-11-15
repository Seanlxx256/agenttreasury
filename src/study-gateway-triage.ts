import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gatewayTriageDatasets } from './gateway-triage-cases.js';
import { prepareGatewayTriage, reviewGatewayTriage, type TriageAction } from './gateway-triage.js';

const pairs = [
  ['Gateway accepted the transfer and polling is active', 'Seller trace exists while the latest Gateway report is still pending'],
  ['Lookup is unavailable after the retry budget was exhausted', 'Polling paused after Gateway became unavailable following a pending result'],
  ['Contradictory transfer terms survive a later outage', 'Multiple Gateway matches conflict with a previously posted charge'],
  ['Confirmed charge with no trace saved on either side', 'Gateway reported a charge before accounting posted and the seller trace is missing'],
  ['Saved buyer trace and posted journal during a Gateway outage', 'Older Gateway confirmation supports closure after a newer lookup failed'],
  ['A failed transfer conflicts with a posted journal', 'Gateway reported failure after the seller saved the trace'],
] as const;

const actions = ['check-gateway', 'wait-for-gateway', 'retrieve-delivery', 'contact-merchant',
  'review-conflict', 'escalate', 'close-case'] as const;

type Cohort = 'A' | 'B';
type Condition = 'rules' | 'assisted';
type StudyIO = { ask: (prompt: string) => Promise<string>; show: (text: string) => void };
type Trial = {
  case: string;
  condition: Condition;
  action: TriageAction;
  citations: string[];
  actionCorrect: boolean;
  evidenceComplete: boolean;
  correct: boolean;
  totalMs: number;
  modelStatus: string | null;
  modelWaitMs: number;
  additionalEvidence: string[];
};

export function operatorStudyPlan(cohort: Cohort) {
  const datasets = [gatewayTriageDatasets['gateway-triage-v1'], gatewayTriageDatasets['gateway-incidents-v1']];
  // Alternate conditions and separate the two cases in each pair by six trials.
  return [0, 1].flatMap((round) => pairs.map((pair, index) => {
    const variant = (round + index) % 2;
    const sample = datasets[variant]?.find(({ name }) => name === pair[variant]);
    if (!sample) throw new Error('Operator study case missing: ' + pair[variant]);
    const condition: Condition = (round + index + Number(cohort === 'B')) % 2 === 0 ? 'rules' : 'assisted';
    return { sample, condition };
  }));
}

export async function runGatewayOperatorStudy(
  cohort: Cohort, model: string, io: StudyIO | 'simulate', request: typeof fetch = fetch, now = () => performance.now(),
) {
  const plan = operatorStudyPlan(cohort);
  const trials: Trial[] = [];
  for (const [index, { sample, condition }] of plan.entries()) {
    if (io !== 'simulate') await io.ask(`\nPress Enter to open case ${index + 1}/${plan.length}. `);
    const start = now();
    const input = prepareGatewayTriage(sample.purchase, sample.observations);
    let modelStatus: string | null = null;
    let modelWaitMs = 0;
    let additionalEvidence: string[] = [];
    if (condition === 'assisted') {
      const modelStart = now();
      const { agent } = await reviewGatewayTriage(input, model, request, 'support-rules');
      modelWaitMs = now() - modelStart;
      modelStatus = agent.status;
      if (agent.status === 'ready') {
        additionalEvidence = agent.recommendation.citations.filter((id) => !input.rules.citations.includes(id));
      }
    }

    const { action, citations } = io === 'simulate' ? input.rules
      : await readDecision(io, input, additionalEvidence, index + 1, plan.length);
    const totalMs = now() - start;
    const actionCorrect = action === sample.expectedAction;
    const relevant = [...sample.requiredCitations, ...(sample.optionalCitations ?? [])];
    const evidenceComplete = sample.requiredCitations.every((id) => citations.includes(id)) &&
      citations.every((id) => relevant.includes(id));
    trials.push({ case: sample.name, condition, action, citations, actionCorrect, evidenceComplete,
      correct: actionCorrect && evidenceComplete, totalMs, modelStatus, modelWaitMs, additionalEvidence });
  }

  const summary = Object.fromEntries((['rules', 'assisted'] as const).map((condition) => {
    const rows = trials.filter((trial) => trial.condition === condition);
    const times = rows.filter(({ correct }) => correct).map(({ totalMs }) => totalMs).sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    const median = times.length ? (times[Math.floor((times.length - 1) / 2)]! + times[middle]!) / 2 : null;
    return [condition, { trials: rows.length, correct: times.length, medianCorrectMs: median,
      modelReady: rows.filter(({ modelStatus }) => modelStatus === 'ready').length,
      withAdditionalEvidence: rows.filter(({ additionalEvidence }) => additionalEvidence.length > 0).length }];
  }));
  return { study: 'gateway-operator-v1', source: io === 'simulate' ? 'simulation' : 'operator', cohort, model,
    ...(io === 'simulate' ? { strategy: 'submit-rule-action-and-required-evidence' } : {}), summary, trials };
}

async function readDecision(
  io: StudyIO, input: ReturnType<typeof prepareGatewayTriage>, additionalEvidence: string[], caseNumber: number, total: number,
) {
  io.show(`\nCase ${caseNumber} of ${total}\nRecommended action: ${input.rules.action}\n${input.rules.rationale}`);
  io.show(`Required evidence: ${input.rules.citations.join(', ')}`);
  if (additionalEvidence.length) io.show(`Additional evidence: ${additionalEvidence.join(', ')}`);
  io.show(input.facts.map(({ id, description }) => `  ${id} · ${description}`).join('\n'));
  io.show(actions.map((action, i) => `  ${i + 1} · ${action}`).join('\n'));
  let action;
  while (!action) {
    const selection = (await io.ask('Next action number: ')).trim();
    if (/^[1-7]$/.test(selection)) action = actions[Number(selection) - 1];
  }
  for (;;) {
    const citations = (await io.ask('Supporting evidence IDs, separated by commas: ')).split(',').map((id) => id.trim());
    if (new Set(citations).size === citations.length && citations.every((id) => input.facts.some((fact) => fact.id === id))) {
      return { action, citations };
    }
    io.show('Enter distinct IDs from the saved evidence.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: { cohort, model, simulate } } = parseArgs({ options: {
    cohort: { type: 'string' }, model: { type: 'string' }, simulate: { type: 'boolean' },
  } });
  if ((cohort !== undefined && cohort !== 'A' && cohort !== 'B') || !model?.trim()) {
    throw new Error('Usage: npm run --silent study:gateway -- --model MODEL [--simulate] [--cohort A|B]');
  }
  if (simulate) {
    const reports = [];
    const groups: Cohort[] = cohort ? [cohort] : ['A', 'B'];
    for (const group of groups) {
      reports.push(await runGatewayOperatorStudy(group, model, 'simulate'));
    }
    console.log(JSON.stringify({ source: 'simulation', reports }, null, 2));
    if (reports.every((report) => !report.summary.assisted?.modelReady)) process.exitCode = 2;
  } else {
    if (!cohort || !process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error('An operator run needs an interactive terminal and --cohort A or B. Use --simulate to run without input.');
    }
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    const abort = new AbortController();
    terminal.once('close', () => abort.abort());
    terminal.once('SIGINT', () => terminal.close());
    try {
      const study = await runGatewayOperatorStudy(cohort, model, {
        ask: (prompt) => terminal.question(prompt, { signal: abort.signal }),
        show: (message) => process.stderr.write(message + '\n'),
      });
      console.log(JSON.stringify(study, null, 2));
    } catch (error) {
      if (!abort.signal.aborted) throw error;
      process.exitCode = 130;
    } finally {
      terminal.close();
    }
  }
}
