import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { schemaVersion } from '../src/migrate.js';

test('standalone recovery drill kills and restarts a real HTTP API, records evidence, cleans up and refuses overwrite', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ag-drill-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../../scripts/investigation-recovery-drill.mjs', import.meta.url));
  const output = join(directory, 'recovery.json');
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      DATABASE_URL: 'postgres://must-not-be-used@127.0.0.1:1/forbidden', GATEWAY_INVESTIGATION_MODEL: 'must-not-be-used' },
    timeout: 45000, maxBuffer: 256 * 1024,
  });
  const result = await run('--output', output);
  assert.match(result.stdout, /drill passed/); assert.doesNotMatch(result.stdout, /operations token/i);
  const bytes = await readFile(output), events = await readFile(output + '.events.jsonl');
  const report = JSON.parse(bytes.toString());
  assert.equal(report.status, 'passed'); assert.equal(report.mode, 'http-automatic'); assert.equal(report.databaseSchema, schemaVersion);
  assert.equal(report.boundaries.browserActionsAttestedByScript, false); assert.equal(report.boundaries.modelEvaluation, false);
  assert.ok(Object.values(report.assertions).every((value) => value === true));
  assert.equal(report.queueBefore.summary.unfinishedCount, 1); assert.equal(report.queueAfter.summary.unfinishedCount, 0);
  assert.equal(report.recovery.savedChecksBeforeCrash, 1); assert.equal(report.recovery.completedChecks, 2); assert.equal(report.recovery.reportCount, 1);
  assert.deepEqual(report.businessTables.before, report.businessTables.after);
  assert.ok(Object.keys(report.businessTables.before).length >= 15);
  assert.deepEqual(report.cleanup, { apiProcessesStopped: true, databaseStopped: true, temporaryDirectoryRemoved: true });
  assert.equal(report.eventsSha256, createHash('sha256').update(events).digest('hex'));
  const messages = events.toString().trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((event) => event.event), ['started','fixture-created','first-check-saved','api-killed',
    'restarted-api-discovered-checkpoint','recovery-verified','finished']);
  assert.equal(messages.find((event) => event.event === 'api-killed').signal, 'SIGKILL');
  assert.ok(report.files['scripts/investigation-recovery-drill.mjs']); assert.ok(report.files['console/console.js']);
  assert.ok(!bytes.toString().includes('DRILL_OPERATIONS_TOKEN')); assert.ok(!bytes.toString().includes('password'));
  await assert.rejects(run('--output', output), /EEXIST/);
  assert.deepEqual(await readFile(output), bytes); assert.deepEqual(await readFile(output + '.events.jsonl'), events);
  const collision = join(directory, 'collision.json'); await writeFile(collision + '.events.jsonl', 'keep-existing');
  await assert.rejects(run('--output', collision), /EEXIST/);
  assert.equal(await readFile(collision, 'utf8'), ''); assert.equal(await readFile(collision + '.events.jsonl', 'utf8'), 'keep-existing');
  await assert.rejects(run('--unexpected'), /Unknown option/);
});
