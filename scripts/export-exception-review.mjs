import { loadFrozenExceptionBenchmark } from '../dist/src/evaluate-gateway-exceptions.js';

// Export inputs only for another reviewer. Do not send labels or model scores
// with this template. Exporting a template is not independent adjudication.
const benchmark = await loadFrozenExceptionBenchmark();
console.log(JSON.stringify({
  dataset: 'evidence-exceptions-v2', manifestHash: benchmark.manifestHash,
  reviewer: null, reviewStatus: 'unreviewed',
  instructions: 'Label currently asserted concrete failures only. Leave uncertain items marked uncertain; add supporting character spans and a rationale. Do not consult the existing labels or model outputs.',
  cases: benchmark.cases.map(({ id, text }) => ({ id, text, signals: null, support: null, rationale: null, confidence: null })),
}, null, 2));
