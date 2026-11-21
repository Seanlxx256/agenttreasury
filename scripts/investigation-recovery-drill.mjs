import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migrate, schemaVersion } from '../dist/src/migrate.js';
import { seedGateway } from '../dist/src/seed.js';

const { values } = parseArgs({ options: { output: { type: 'string' }, interactive: { type: 'boolean' } } });
if (!values.output) throw new Error('Usage: npm run drill:investigation -- --output NEW_REPORT.json [--interactive]');
const root = fileURLToPath(new URL('../', import.meta.url)), output = resolve(values.output);
const final = await open(output, 'wx');
let events;
try { events = await open(output + '.events.jsonl', 'wx'); } catch (error) { await final.close(); throw error; }
const hash = (value) => createHash('sha256').update(value).digest('hex');
const abort = new AbortController();
const interrupt = () => abort.abort();
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const report = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), mode: values.interactive ? 'console-assisted' : 'http-automatic',
  scope: 'Synthetic local recovery drill using disposable PostgreSQL, actual loopback HTTP API and production investigation handlers.',
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  boundaries: { livePayments: false, walletUsed: false, modelEvaluation: false, existingDatabaseUsed: false,
    browserActionsAttestedByScript: false, independentHumanReview: false, productionReadiness: false }, assertions: {} };
let phase = 'reserve-output', directory, postgres, pool, databaseStarted = false, unexpectedFetches = 0;
const children = [];
function check(condition, code) { if (!condition) throw Object.assign(new Error(code), { drillCode: code }); }
async function record(event, details = {}) {
  await events.writeFile(JSON.stringify({ event, at: new Date().toISOString(), ...details }) + '\n'); await events.sync();
}
async function manifest() {
  const files = ['package.json','package-lock.json','scripts/investigation-drill-api.mjs','scripts/investigation-recovery-drill.mjs',
    'console/console.js','console/index.html','console/console.css'];
  for (const directory of ['src','dist/src','db']) {
    for (const name of (await readdir(join(root, directory))).sort()) {
      if (name.endsWith(directory === 'src' ? '.ts' : directory === 'db' ? '.sql' : '.js')) files.push(directory + '/' + name);
    }
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => [file, hash(await readFile(join(root, file)))])));
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
const tables = ['research_tasks','daily_spend','payment_intents','gateway_demo_purchases','gateway_task_grants',
  'gateway_demo_deliveries','gateway_payment_journal','gateway_payment_journal_lines','gateway_payment_observations',
  'gateway_refund_requests','gateway_refund_authorizations','gateway_payment_refunds','gateway_signatures',
  'gateway_reconciliation_cases','audit_history'];
async function businessSnapshot() {
  const result = {};
  for (const table of tables) {
    const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
    result[table] = { rows: rows.length, sha256: hash(JSON.stringify(rows)) };
  }
  return result;
}
async function waitUntil(read, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    abort.signal.throwIfAborted(); const result = await read(); if (result) return result;
    await delay(100, undefined, { signal: abort.signal });
  }
  throw Object.assign(new Error('Drill wait timed out'), { drillCode: 'DRILL_TIMEOUT' });
}
function launch(config, token, pause) {
  const env = Object.fromEntries(['PATH','TMPDIR','TEMP','TMP','SystemRoot'].flatMap((key) => process.env[key] ? [[key,process.env[key]]] : []));
  Object.assign(env, { DRILL_DATABASE_CONFIG: JSON.stringify(config), DRILL_OPERATIONS_TOKEN: token, DRILL_PAUSE_FIRST_SAVE: String(pause) });
  const child = fork(join(root, 'scripts/investigation-drill-api.mjs'), [], { cwd: root, env, execArgv: [], stdio: ['ignore','ignore','ignore','ipc'] });
  const state = { child, messages: [], exited: false, signal: null };
  child.on('message', (message) => { state.messages.push(message); if (message.event === 'unexpected-fetch') unexpectedFetches++; });
  child.on('error', () => state.messages.push({ event: 'failed' }));
  child.on('exit', (_, signal) => { state.exited = true; state.signal = signal; });
  children.push(state); return state;
}
async function message(state, event) {
  return waitUntil(() => {
    const result = state.messages.find((message) => message.event === event);
    if (result) return result;
    check(!state.exited && !state.messages.some((message) => message.event === 'failed'), 'API_CHILD_FAILED'); return null;
  });
}
async function request(url, token, method = 'GET', body) {
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), redirect: 'error' });
  return { status: response.status, noStore: response.headers.get('cache-control') === 'no-store', body: await response.json() };
}
try {
  await record('started', { mode: report.mode });
  phase = 'start-isolated-database'; report.files = await manifest();
  directory = await mkdtemp(join(tmpdir(), 'ag-recovery-drill-'));
  const config = { host: '127.0.0.1', port: await freePort(), password: randomBytes(32).toString('hex'), user: 'postgres', database: 'postgres' };
  postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), port: config.port, password: config.password,
    persistent: true, postgresFlags: ['-h','127.0.0.1','-k',directory], onLog: () => {}, onError: () => {} });
  await postgres.initialise(); await postgres.start(); databaseStarted = true;
  pool = new pg.Pool({ ...config, connectionTimeoutMillis: 3000 }); await migrate(pool);
  report.databaseSchema = schemaVersion;
  const operations = randomBytes(32).toString('hex'), requestId = randomUUID();
  const payer = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`;
  const seeded = await seedGateway(pool, { origin: 'https://merchant.invalid', payer, recipient });
  await pool.query(`INSERT INTO gateway_demo_purchases(request_id,endpoint,nonce,payer,recipient,amount_units,task_id,budget_day,budget_status,retrieval_token)
    VALUES($1,'https://merchant.invalid/trace',$2,$3,$4,1000,$5,current_date,'reserved','synthetic-retrieval-not-a-live-secret')`,
  [requestId,`0x${randomBytes(32).toString('hex')}`,payer,recipient,seeded.taskId]);
  await pool.query(`INSERT INTO gateway_payment_journal(request_id,transfer_id,batch_hash,amount) VALUES($1,$2,$3,2000)`, [requestId,randomUUID(),`0x${'4'.repeat(64)}`]);
  await pool.query(`INSERT INTO gateway_payment_observations(request_id,source,evidence) VALUES($1,'worker','{"status":"conflict","reason":"accounting-mismatch"}')`, [requestId]);
  const before = await businessSnapshot();
  report.requestId = requestId; await record('fixture-created', { schemaVersion });
  phase = 'interrupt-first-api';
  const first = launch(config, operations, true), firstUrl = (await message(first, 'ready')).url;
  const path = `/finance/gateway-purchases/${requestId}/investigation`;
  const pendingRequest = request(firstUrl + path, operations, 'POST', { refreshExternal: false })
    .then((value) => ({ response: value }), () => ({ connectionLost: true }));
  const checkpointId = (await message(first, 'checkpoint-saved')).checkpointId;
  report.checkpointId = checkpointId;
  const partial = await request(firstUrl + path + '/checkpoints/' + checkpointId, operations);
  check(partial.status === 200 && partial.body.progress.checks.length === 1 && partial.body.status === 'in-progress', 'FIRST_CHECK_NOT_DURABLE');
  const busy = await request(firstUrl + path + '/checkpoints/' + checkpointId + '/resume', operations, 'POST', {});
  check(busy.status === 409 && busy.body.code === 'INVESTIGATION_BUSY', 'CONCURRENT_RECOVERY_NOT_BLOCKED');
  await record('first-check-saved', { checkpointId, savedChecks: 1, concurrentRecoveryStatus: busy.status });
  first.child.kill('SIGKILL'); await waitUntil(() => first.exited);
  check(first.signal === 'SIGKILL' && (await pendingRequest).connectionLost, 'INTERRUPTION_NOT_OBSERVED');
  await record('api-killed', { signal: first.signal });
  phase = 'restart-and-discover';
  const second = launch(config, operations, false), base = (await message(second, 'ready')).url;
  const queueUrl = base + '/finance/operations/investigations', resumeUrl = base + path + '/checkpoints/' + checkpointId + '/resume';
  const queueBefore = await request(queueUrl, operations);
  check(queueBefore.status === 200 && queueBefore.noStore && queueBefore.body.summary.unfinishedCount === 1
    && queueBefore.body.checkpoints[0]?.id === checkpointId && queueBefore.body.checkpoints[0]?.savedChecks === 1, 'RESTARTED_QUEUE_MISSING_CHECKPOINT');
  report.queueBefore = queueBefore.body;
  await record('restarted-api-discovered-checkpoint', { checkpointId, unfinishedCount: 1 });
  phase = 'recover-through-http';
  if (values.interactive) {
    console.log(`Isolated console: ${base}/finance`);
    console.log(`Temporary operations token: ${operations}`);
    console.log('Open Unfinished investigations, inspect the evidence, then select Resume investigation. No wallet is used.');
    await waitUntil(async () => {
      const saved = await request(base + path + '/checkpoints/' + checkpointId, operations);
      return saved.status === 200 && saved.body.status === 'finished';
    }, 300000);
  } else {
    const recovered = await request(resumeUrl, operations, 'POST', {});
    check(recovered.status === 200, 'HTTP_RECOVERY_FAILED');
  }
  const recovered = await request(base + path, operations);
  check(recovered.status === 200 && recovered.body.guided.stopReason === 'checklist-collected'
    && recovered.body.checks.length === 2 && recovered.body.staleNow === false, 'INCOMPLETE_RECOVERY_REPORT');
  check(isDeepStrictEqual(recovered.body.checks[0], partial.body.progress.checks[0]), 'SAVED_EVIDENCE_CHANGED');
  const repeated = await request(resumeUrl, operations, 'POST', {});
  check(repeated.status === 200 && repeated.body.runId === recovered.body.runId, 'DUPLICATE_REPORT_ON_RETRY');
  const { rows: [count] } = await pool.query('SELECT count(*)::int n FROM gateway_investigation_runs WHERE request_id=$1', [requestId]);
  check(count.n === 1, 'REPORT_COUNT_NOT_ONE');
  const queueAfter = await request(queueUrl, operations);
  check(queueAfter.status === 200 && queueAfter.body.summary.unfinishedCount === 0 && queueAfter.body.checkpoints.length === 0, 'QUEUE_DID_NOT_CLEAR');
  const after = await businessSnapshot(); check(isDeepStrictEqual(before, after), 'FINANCIAL_STATE_CHANGED');
  check(unexpectedFetches === 0, 'UNEXPECTED_PROVIDER_OR_MODEL_FETCH');
  report.queueAfter = queueAfter.body; report.runId = recovered.body.runId;
  report.recovery = { stopReason: recovered.body.guided.stopReason, savedChecksBeforeCrash: 1, completedChecks: 2,
    firstEvidenceDigest: hash(JSON.stringify(partial.body.progress.checks[0])), reportCount: count.n };
  report.businessTables = { before, after };
  report.assertions = { firstCheckDurable: true, concurrentRecoveryRejected: true, realApiProcessKilled: true,
    restartedApiDiscoveredCheckpoint: true, originalEvidencePreserved: true, repeatedResumeSameReport: true,
    exactlyOneReport: true, queueCleared: true, financialTablesUnchanged: true, noProviderOrModelFetch: true };
  await record('recovery-verified', { runId: recovered.body.runId, completedChecks: 2, unfinishedCount: 0, financialTablesUnchanged: true });
  if (values.interactive) {
    console.log('Recovery verified. Inspect the completed console report, then press Enter to stop the isolated services and save the report.');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let entered = false; terminal.once('line', () => { entered = true; });
    try { await waitUntil(() => entered, 300000); } finally { terminal.close(); }
  }
  check(isDeepStrictEqual(report.files, await manifest()), 'SOURCE_OR_COMPILED_FILES_CHANGED');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { phase, code: error.drillCode ?? 'DRILL_FAILED', type: error.name ?? 'Error' };
  await record('failed', report.failure); process.exitCode = 1;
} finally {
  phase = 'cleanup';
  try {
    for (const state of children) {
      if (!state.exited) {
        if (state.child.connected) state.child.send({ event: 'shutdown' }, () => {});
        for (let n = 0; n < 30 && !state.exited; n++) await delay(100);
        if (!state.exited) { state.child.kill('SIGKILL'); for (let n = 0; n < 30 && !state.exited; n++) await delay(100); }
        check(state.exited, 'API_CLEANUP_FAILED');
      }
    }
    await pool?.end(); if (databaseStarted) await postgres.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
    report.cleanup = { apiProcessesStopped: true, databaseStopped: true, temporaryDirectoryRemoved: true };
  } catch { report.status = 'failed'; report.cleanup = { complete: false }; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await record('finished', { status: report.status, cleanup: report.cleanup });
  await events.close(); report.eventsSha256 = hash(await readFile(output + '.events.jsonl'));
  await final.writeFile(JSON.stringify(report, null, 2) + '\n'); await final.sync(); await final.close();
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
console.log(`Investigation recovery drill ${report.status}: ${output}`);
