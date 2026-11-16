import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operatorStudyPlan, runGatewayOperatorStudy } from '../src/study-gateway-triage.js';

test('study counterbalances distinct cases and includes model wait in correct decision time', async () => {
  const plan = operatorStudyPlan('A');
  const other = operatorStudyPlan('B');
  assert.equal(new Set(plan.map(({ sample }) => sample.name)).size, 12);
  for (const [index, trial] of plan.entries()) {
    assert.equal(trial.sample.name, other[index]?.sample.name);
    assert.notEqual(trial.condition, other[index]?.condition);
    assert.equal(trial.sample.expectedAction, plan[(index + 6) % 12]?.sample.expectedAction);
    assert.notEqual(trial.condition, plan[(index + 6) % 12]?.condition);
  }

  const actionNumbers = { 'check-gateway': 1, 'wait-for-gateway': 2, 'retrieve-delivery': 3,
    'contact-merchant': 4, 'review-conflict': 5, escalate: 6, 'close-case': 7, 'raise-dispute': 8 };
  let index = -1;
  let time = 0;
  let calls = 0;
  const report = await runGatewayOperatorStudy('A', 'test-model', {
    show: () => {},
    async ask(prompt) {
      if (prompt.includes('Press Enter')) { index++; time += 1000; return ''; }
      const sample = plan[index]!.sample;
      if (prompt.includes('Next action')) return String(actionNumbers[sample.expectedAction]);
      time += 500;
      return (index === 0 ? ['budget'] : sample.requiredCitations).join(',');
    },
  }, async (_url, init) => {
    calls++;
    time += 250;
    if (calls === 1) return new Response(null, { status: 503 });
    const { messages } = JSON.parse(String(init?.body));
    const { allowed } = JSON.parse(messages[1].content);
    assert.equal(allowed.length, 1);
    const { action, requiredCitations } = allowed[0];
    return Response.json({ message: { content: JSON.stringify({ action, citations: requiredCitations }) } });
  }, () => time);

  assert.equal(calls, 6);
  assert.equal(report.trials[0]?.actionCorrect, true);
  assert.equal(report.trials[0]?.evidenceComplete, false);
  assert.deepEqual(report.summary.rules, {
    trials: 6, correct: 5, medianCorrectMs: 500, modelReady: 0, withAdditionalEvidence: 0,
  });
  assert.deepEqual(report.summary.assisted, {
    trials: 6, correct: 6, medianCorrectMs: 750, modelReady: 5, withAdditionalEvidence: 0,
  });
});

test('headless simulation labels the report and still calls the model for assisted cases', async () => {
  let modelCalls = 0;
  const report = await runGatewayOperatorStudy('B', 'test-model', 'simulate', async () => {
    modelCalls++;
    return new Response(null, { status: 503 });
  });
  assert.equal(report.source, 'simulation');
  assert.equal(report.trials.length, 12);
  assert.equal(modelCalls, 6);
  assert.equal(report.summary.assisted?.modelReady, 0);
  assert.ok(report.trials.every((trial) => trial.correct));
});
