import { execFile } from 'node:child_process';
import { promisify, parseArgs, isDeepStrictEqual } from 'node:util';
import { open, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local acceptance only. No dotenv, signer, wallet launcher, RPC or Ollama invocation.
const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw new Error('Usage: npm run verify:portfolio -- --output <new-report.json>');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(values.output);
const reportFile = await open(output, 'wx');
const environment = Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
const invoke = promisify(execFile), hash = (value) => createHash('sha256').update(value).digest('hex');
const report = { schemaVersion: 1, scope: 'Local portfolio acceptance with disposable PostgreSQL and loopback fixtures; archived testnet consistency replay, no new chain reads or payments.',
  startedAt: new Date().toISOString(), node: process.version, passed: false, steps: [],
  externalValidation: { independentHumanReview: false, operatorTimeSavings: false, productionSoak: false, containerDeployment: false, mainnet: false } };
const artifact = (suffix) => output + suffix;
const names = await readdir(root + 'test');
const testNames = names.filter((name) => name.endsWith('.test.ts')).sort();
async function manifest() {
  const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'scripts/verify-portfolio.mjs', 'docs/evidence/stage-6-modern-signing.json'];
  for (const directory of ['src', 'test', 'db', 'dist/src', 'dist/test']) {
    const extension = directory === 'db' ? '.sql' : directory.startsWith('dist') ? '.js' : '.ts';
    for (const name of (await readdir(root + directory)).filter((n) => n.endsWith(extension)).sort()) files.push(`${directory}/${name}`);
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async (name) => [name, hash(await readFile(root + name))])));
}
async function run(name, args, suffix) {
  console.error(`Verifying ${name}...`); const started = performance.now();
  let result;
  try { result = await invoke(process.execPath, args, { cwd: root, env: environment, timeout: 240000, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) {
    await writeFile(artifact(suffix), String(error.stdout ?? '') + '\n' + String(error.stderr ?? ''), { flag: 'wx' });
    report.steps.push({ name, passed: false, durationMs: performance.now() - started, log: relative(dirname(output), artifact(suffix)) });
    throw new Error(`${name} failed; inspect ${artifact(suffix)}`);
  }
  await writeFile(artifact(suffix), result.stdout + (result.stderr ? '\n' + result.stderr : ''), { flag: 'wx' });
  report.steps.push({ name, passed: true, durationMs: performance.now() - started, log: relative(dirname(output), artifact(suffix)) });
  return result.stdout;
}
try {
  // Refuse sidecar collisions before starting work; every later write also uses exclusive creation.
  for (const suffix of ['.build.log', '.tests.tap', '.signing.json', '.rules.log', '.rules.json', '.rules.json.plan.json', '.rules.json.cases.jsonl', '.review.log', '.review-form.json']) {
    try { const handle = await open(artifact(suffix), 'r'); await handle.close(); throw new Error(`Output exists: ${artifact(suffix)}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await run('TypeScript build', [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], '.build.log');
  const before = await manifest();
  const tap = await run('full regression', ['--test', '--test-concurrency=1', '--test-reporter=tap',
    ...testNames.map((name) => join(root, 'dist/test', name.replace(/\.ts$/, '.js')))], '.tests.tap');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map((key) => {
    const match = tap.match(new RegExp(`^# ${key} (\\d+)$`, 'm')); return [key, match ? Number(match[1]) : null];
  }));
  if (!counts.tests || counts.pass !== counts.tests || counts.fail !== 0 || counts.cancelled !== 0 || counts.skipped !== 0)
    throw new Error('Regression summary is incomplete or contains failures/skips');
  report.tests = counts;
  const signing = await run('archived testnet acceptance replay', ['dist/src/verify-gateway-signing-acceptance.js', 'docs/evidence/stage-6-modern-signing.json'], '.signing.json');
  report.archivedSigning = JSON.parse(signing); if (report.archivedSigning.verified !== true) throw new Error('Archived acceptance replay failed');
  await run('rules-only packet evaluation', ['dist/src/evaluate-case-packets.js', '--rules-only', '--output', artifact('.rules.json')], '.rules.log');
  const rules = JSON.parse(await readFile(artifact('.rules.json'), 'utf8'));
  if (!rules.finishedAt || rules.model !== null || rules.summary.baseline.cases !== 12) throw new Error('Rules evaluation incomplete');
  report.packetEvaluation = { protocol: rules.protocol, summary: rules.summary, independentReview: false };
  await run('blank review-form export', ['dist/src/evaluate-case-packets.js', '--export-review', '--output', artifact('.review-form.json')], '.review.log');
  const form = JSON.parse(await readFile(artifact('.review-form.json'), 'utf8'));
  if (form.schemaVersion !== 2 || form.cases.length !== 12 || form.cases.some((row) => row.annotation.status !== 'unreviewed' || row.annotation.issues.length))
    throw new Error('Review export unexpectedly contains completed labels');
  const after = await manifest(); if (!isDeepStrictEqual(before, after)) throw new Error('Source or compiled files changed during acceptance');
  report.files = after;
  report.artifacts = Object.fromEntries(await Promise.all(report.steps.map(async ({ log }) => [log, hash(await readFile(resolve(dirname(output), log)))])));
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportFile.close();
}
console.error(JSON.stringify({ passed: report.passed, tests: report.tests, report: output, error: report.error }, null, 2));
