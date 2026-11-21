import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { planFrozenClaimEvaluation, writeClaimPlan, runFrozenClaimEvaluation } from './frozen-claim-evaluation.js';

export async function frozenClaimEvaluationCli(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { plan: { type: 'boolean' }, run: { type: 'string' },
    labels: { type: 'string' }, review: { type: 'string' }, model: { type: 'string' }, output: { type: 'string' } } });
  if (!!values.plan === !!values.run || !values.labels || !values.review || !values.output
    || (values.plan && !values.model) || (values.run && values.model))
    throw new Error('Use --plan --model INSTALLED_MODEL or --run PLAN_FILE, with --labels FROZEN_FILE --review ORIGINAL_REVIEW --output NEW_FILE');
  if (values.plan) {
    const plan = await planFrozenClaimEvaluation(values.labels, values.review, values.model!);
    await writeClaimPlan(values.output, plan);
    console.log('Execution plan saved; no model inference performed. Reviewer declarations are not independently verified.');
  } else {
    const report = await runFrozenClaimEvaluation(values.run!, values.labels, values.review, values.output);
    console.log(JSON.stringify(report.summary, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  frozenClaimEvaluationCli().catch((error) => { console.error(error instanceof Error ? error.message : 'Evaluation failed'); process.exitCode = 1; });
}
