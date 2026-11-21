import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { extractClaimMaterials } from '../dist/src/gateway-claim-materials.js';
import { statementSources } from '../dist/src/gateway-case-packet.js';
import { packetEvaluationHashes } from '../dist/src/evaluate-case-packets.js';

const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values.input && values.output, 'Use --input CAPTURED_REPORT --output NEW_FILE');
const bytes = await readFile(values.input);
const previous = JSON.parse(bytes);
assert.equal(previous.protocol, 'claim-assessment-development-v1'); assert.ok(previous.finishedAt);
const files = await packetEvaluationHashes();
files['scripts/evaluate-material-replay.mjs'] = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const rows = previous.cases.map((sample) => {
  const candidates = extractClaimMaterials(statementSources(sample.input));
  const supports = (candidate, label) => candidate.field === label.field && candidate.sourceId === label.sourceId && candidate.quote.includes(label.quote);
  return { id: sample.id, candidates, expected: sample.expected.materials.length,
    found: sample.expected.materials.filter((l) => candidates.some((c) => supports(c, l))).length,
    unsupported: candidates.filter((c) => !sample.expected.materials.some((l) => supports(c, l))).length };
});
const report = { protocol: 'claim-material-development-replay-v1', createdAt: new Date().toISOString(), node: process.version,
  inputSha256: createHash('sha256').update(bytes).digest('hex'), files, modelInference: false, independentReview: false, promotionEligible: false,
  limitation: 'Deterministic parser developed after seeing the paired run. Same known development labels, not holdout accuracy, model improvement or human efficiency.',
  summary: { cases: rows.length, modelFoundInOriginalRun: previous.summary.materialFound,
    parserFound: rows.reduce((n, r) => n + r.found, 0), expected: rows.reduce((n, r) => n + r.expected, 0),
    unsupportedParserCandidates: rows.reduce((n, r) => n + r.unsupported, 0) }, rows };
const handle = await open(values.output, 'wx');
try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync(); }
finally { await handle.close(); }
console.log(JSON.stringify(report.summary, null, 2));
