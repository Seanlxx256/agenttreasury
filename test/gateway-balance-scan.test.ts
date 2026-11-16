import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { type Address, type Hash } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gatewayBalanceScanMetrics, runGatewayBalanceScan } from '../src/gateway-balance-scanner.js';
import type { GatewayBalanceChain } from '../src/gateway-balance-chain.js';
import { migrate } from '../src/migrate.js';

async function availablePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function fakeChain(overrides: Partial<GatewayBalanceChain> = {}): GatewayBalanceChain {
  const blockHash = async (block: bigint) => `0x${block.toString(16).padStart(64, '0')}` as Hash;
  return {
    network: 'arcTestnet',
    async finalized() { return 100n; },
    blockHash,
    async totalBalance() { return 0n; },
    async receiptBlock() { return null; },
    async movements() {
      return { deposits: [], withdrawals: [], burns: [], batches: [] } as
        Awaited<ReturnType<GatewayBalanceChain['movements']>>;
    },
    ...overrides,
  };
}

const mismatchChain = () => fakeChain({
  async totalBalance(_wallet, block) { return block === 100n ? 1000n : 0n; },
});

test('continuous balance scan persists progress, raises work orders, and recovers', { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agbs-'));
  const port = await availablePort();
  const password = randomUUID();
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'data'),
    port,
    password,
    persistent: true,
    onLog: () => {},
    onError: (message) => t.diagnostic(String(message)),
    postgresFlags: ['-h', '127.0.0.1', '-k', directory],
  });
  let started = false;
  const pool = new Pool({ host: '127.0.0.1', port, database: 'postgres', user: 'postgres', password });
  t.after(async () => {
    try {
      await pool.end();
      if (started) await postgres.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await postgres.initialise();
  await postgres.start();
  started = true;
  await migrate(pool);

  const payer = () => privateKeyToAccount(generatePrivateKey()).address as Address;

  await t.test('a matched scan persists its result and advances the cursor', async () => {
    const account = payer();
    const outcome = await runGatewayBalanceScan(pool, fakeChain(), account);
    assert.equal(outcome.status, 'matched');
    if (outcome.status === 'matched') assert.equal(outcome.discrepancies, 0);

    const { rows: [scan] } = await pool.query(
      'SELECT status, from_block::text AS "fromBlock", to_block::text AS "toBlock" FROM gateway_balance_scans WHERE payer = $1',
      [account.toLowerCase()]);
    assert.equal(scan.status, 'matched');
    assert.equal(scan.fromBlock, '1');
    assert.equal(scan.toBlock, '100');

    const { rows: [cursor] } = await pool.query(
      'SELECT next_block::text AS "nextBlock" FROM gateway_balance_cursors WHERE network = $1 AND payer = $2',
      ['arcTestnet', account.toLowerCase()]);
    assert.equal(cursor.nextBlock, '101');

    const upToDate = await runGatewayBalanceScan(pool, fakeChain(), account);
    assert.equal(upToDate.status, 'up-to-date');
  });

  await t.test('a discrepancy scan raises open work orders and reports metrics', async () => {
    const account = payer();
    const outcome = await runGatewayBalanceScan(pool, mismatchChain(), account);
    assert.equal(outcome.status, 'discrepancy');
    if (outcome.status === 'discrepancy') assert.ok(outcome.discrepancies >= 1);

    const { rows } = await pool.query(
      `SELECT kind, status FROM gateway_balance_discrepancies WHERE scan_id = $1 ORDER BY kind`,
      [outcome.scanId]);
    assert.ok(rows.some((row: { kind: string; status: string }) => row.kind === 'balance' && row.status === 'open'));

    const metrics = await gatewayBalanceScanMetrics(pool, account);
    assert.ok(metrics.latestScan);
    assert.equal(metrics.latestScan.status, 'discrepancy');
    assert.equal(metrics.totalOpenDiscrepancies, rows.filter((row: { status: string }) => row.status === 'open').length);
    assert.ok((metrics.openDiscrepancies.balance ?? 0) >= 1);
  });

  await t.test('re-running the same window is idempotent and adds no duplicate work orders', async () => {
    const account = payer();
    await runGatewayBalanceScan(pool, mismatchChain(), account);
    const before = await pool.query(
      'SELECT count(*)::int AS n FROM gateway_balance_discrepancies d JOIN gateway_balance_scans s ON s.id = d.scan_id WHERE s.payer = $1',
      [account.toLowerCase()]);

    await pool.query('DELETE FROM gateway_balance_cursors WHERE network = $1 AND payer = $2',
      ['arcTestnet', account.toLowerCase()]);
    const outcome = await runGatewayBalanceScan(pool, mismatchChain(), account);
    assert.equal(outcome.status, 'already-scanned');

    const after = await pool.query(
      'SELECT count(*)::int AS n FROM gateway_balance_discrepancies d JOIN gateway_balance_scans s ON s.id = d.scan_id WHERE s.payer = $1',
      [account.toLowerCase()]);
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  await t.test('an expired running scan is recovered instead of blocking forever', async () => {
    const account = payer();
    const scanId = randomUUID();
    await pool.query(`
      INSERT INTO gateway_balance_scans (id, network, payer, from_block, to_block, status, lease_until, started_at)
      VALUES ($1, 'arcTestnet', $2, 1, 100, 'running', now() - interval '1 minute', now())
    `, [scanId, account.toLowerCase()]);

    const outcome = await runGatewayBalanceScan(pool, fakeChain(), account);
    assert.equal(outcome.status, 'matched');

    const { rows: [scan] } = await pool.query(
      'SELECT status, attempts FROM gateway_balance_scans WHERE id = $1', [scanId]);
    assert.equal(scan.status, 'matched');
    assert.ok(scan.attempts >= 1);
  });
});
