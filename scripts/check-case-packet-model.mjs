import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { interpretPacketClaims, packetRuleIssues, statementSources } from '../dist/src/gateway-case-packet.js';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw new Error('Specify --output <new.json> after npm run build');
const model = 'qwen2.5:3b';
const response = await fetch('http://127.0.0.1:11434/api/tags', { redirect: 'error', signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error('Cannot read local model identity');
const identity = (await response.json()).models?.find((row) => row.name === model);
if (!identity?.digest) throw new Error('Install qwen2.5:3b before this local-only smoke check');
const cases = [
  { id: 'compound-complaint', customerStatement: 'I was charged twice and cannot open the purchased data.', merchantStatement: 'We already refunded the order.' },
  { id: 'paraphrase', customerStatement: 'My wallet was debited on two occasions for this one purchase. The download gives me an error instead of the report.', merchantStatement: 'The money has been sent back to the buyer.' },
  { id: 'negative-context', customerStatement: 'There was no duplicate charge. The file opens correctly. I only need a receipt.', merchantStatement: 'No refund has been issued or promised.' },
];
const file = await open(values.output, 'wx');
try {
  const results = [];
  for (const sample of cases) {
    console.error(sample.id);
    const sources = statementSources(sample);
    results.push({ ...sample, ruleIssues: packetRuleIssues(sources), model: await interpretPacketClaims(sources, model) });
  }
  const report = { scope: 'Synthetic local model integration smoke check, not a benchmark or production ROI measurement.',
    runAt: new Date().toISOString(), node: process.version, model: { name: identity.name, digest: identity.digest },
    sourceDigest: createHash('sha256').update(await readFile(new URL('../src/gateway-case-packet.ts', import.meta.url))).digest('hex'), results };
  await file.writeFile(JSON.stringify(report, null, 2) + '\n');
  console.error(JSON.stringify(results.map((row) => ({ id: row.id, status: row.model.status, issues: row.model.issues })), null, 2));
} finally { await file.close(); }
