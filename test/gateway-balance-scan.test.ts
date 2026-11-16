import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { type Address, type Hash } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gatewayBalanceScanMetrics, runGatewayBalanceScan } from '../src/gateway-balance-scanner.js';
import { reconcileGatewayBalances } from '../src/reconcile-gateway-balances.js';
import type { GatewayBalanceChain } from '../src/gateway-balance-chain.js';
import { evidenceDigest, persistBalanceEvidence, replaySavedBalanceScan } from '../src/gateway-balance-evidence.js';
import { gatewayNetworkConfig } from '../src/gateway-x402.js';
import type { BalanceSnapshot } from '../src/reconcile-gateway-balances.js';
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

  await t.test('a failed scan is retried instead of reported already-scanned', async () => {
    const account = payer();
    let calls = 0;
    const flaky = fakeChain({
      async movements() {
        calls += 1;
        if (calls === 1) throw new Error('RPC unavailable');
        return { deposits: [], withdrawals: [], burns: [], batches: [] };
      },
    });

    await assert.rejects(runGatewayBalanceScan(pool, flaky, account), /RPC unavailable/);
    const { rows: [failed] } = await pool.query(
      'SELECT status, attempts FROM gateway_balance_scans WHERE payer = $1', [account.toLowerCase()]);
    assert.equal(failed.status, 'failed');

    const retried = await runGatewayBalanceScan(pool, fakeChain(), account);
    assert.equal(retried.status, 'matched');
    const { rows: [done] } = await pool.query(
      'SELECT status, attempts FROM gateway_balance_scans WHERE payer = $1', [account.toLowerCase()]);
    assert.equal(done.status, 'matched');
    assert.equal(done.attempts, failed.attempts + 1);
  });

  await t.test('a failed first scan is resumed at its original window, not recomputed', async () => {
    const account = payer();
    const scanId = randomUUID();
    await pool.query(`
      INSERT INTO gateway_balance_scans (id, network, payer, from_block, to_block, status, lease_until, started_at)
      VALUES ($1, 'arcTestnet', $2, 1, 50, 'failed', now(), now())
    `, [scanId, account.toLowerCase()]);

    // The finalized height advanced past the failed window; recomputing from the
    // latest height would skip blocks 1..50, so the old window must be resumed.
    const chain = fakeChain({ async finalized() { return 150n; } });
    const outcome = await runGatewayBalanceScan(pool, chain, account);
    assert.equal(outcome.status, 'matched');

    const { rows: [scan] } = await pool.query(
      'SELECT from_block::text AS "fromBlock", to_block::text AS "toBlock", attempts FROM gateway_balance_scans WHERE id = $1',
      [scanId]);
    assert.equal(scan.fromBlock, '1');
    assert.equal(scan.toBlock, '50');
    assert.equal(scan.attempts, 1);
  });

  await t.test('a recovered older window cannot rewind a newer cursor', async () => {
    const account = payer();
    // A newer window already advanced the cursor past the older window's end.
    await pool.query(
      "INSERT INTO gateway_balance_cursors (network, payer, next_block) VALUES ('arcTestnet', $1, 102)",
      [account.toLowerCase()]);
    const scanId = randomUUID();
    await pool.query(`
      INSERT INTO gateway_balance_scans (id, network, payer, from_block, to_block, status, lease_until, started_at)
      VALUES ($1, 'arcTestnet', $2, 1, 100, 'running', now() - interval '1 minute', now())
    `, [scanId, account.toLowerCase()]);

    const outcome = await runGatewayBalanceScan(pool, fakeChain(), account);
    assert.equal(outcome.status, 'matched');

    const { rows: [cursor] } = await pool.query(
      'SELECT next_block::text AS "nextBlock" FROM gateway_balance_cursors WHERE network = $1 AND payer = $2',
      ['arcTestnet', account.toLowerCase()]);
    // The monotonic advance keeps 102 instead of rewinding to 101.
    assert.equal(cursor.nextBlock, '102');
  });

  await t.test('an active lease is reported already-running, not reclaimed', async () => {
    const account = payer();
    const scanId = randomUUID();
    await pool.query(`
      INSERT INTO gateway_balance_scans (id, network, payer, from_block, to_block, status, lease_until, started_at)
      VALUES ($1, 'arcTestnet', $2, 1, 100, 'running', now() + interval '10 minutes', now())
    `, [scanId, account.toLowerCase()]);

    const outcome = await runGatewayBalanceScan(pool, fakeChain(), account);
    assert.equal(outcome.status, 'already-running');
    const { rows: [scan] } = await pool.query(
      'SELECT attempts FROM gateway_balance_scans WHERE id = $1', [scanId]);
    assert.equal(scan.attempts, 0);
  });

  await t.test('a discrepancy scan advances the cursor together with its work orders', async () => {
    const account = payer();
    const outcome = await runGatewayBalanceScan(pool, mismatchChain(), account);
    assert.equal(outcome.status, 'discrepancy');

    const { rows: [cursor] } = await pool.query(
      'SELECT next_block::text AS "nextBlock" FROM gateway_balance_cursors WHERE network = $1 AND payer = $2',
      ['arcTestnet', account.toLowerCase()]);
    assert.equal(cursor.nextBlock, '101');
  });

  await t.test('reconciliation filters purchases by network', async () => {
    const account = payer();
    const recipient = privateKeyToAccount(generatePrivateKey()).address as Address;
    const nonceA = `0x${'a'.repeat(64)}`;
    const nonceB = `0x${'b'.repeat(64)}`;
    const batchA = `0x${'1'.repeat(64)}` as Hash;
    const batchB = `0x${'2'.repeat(64)}`;

    const requestA = randomUUID();
    await pool.query(`
      INSERT INTO gateway_demo_purchases (request_id, endpoint, nonce, payer, recipient, amount_units, network)
      VALUES ($1, $2, $3, $4, $5, $6, 'arcTestnet')
    `, [requestA, 'https://api.example/a', nonceA, account.toLowerCase(), recipient, 1000]);
    await pool.query(`
      INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
      VALUES ($1, $2, $3, $4)
    `, [requestA, 'transfer-a', batchA, 1000]);

    const requestB = randomUUID();
    await pool.query(`
      INSERT INTO gateway_demo_purchases (request_id, endpoint, nonce, payer, recipient, amount_units, network)
      VALUES ($1, $2, $3, $4, $5, $6, 'arc')
    `, [requestB, 'https://api.example/b', nonceB, account.toLowerCase(), recipient, 1000]);
    await pool.query(`
      INSERT INTO gateway_payment_journal (request_id, transfer_id, batch_hash, amount)
      VALUES ($1, $2, $3, $4)
    `, [requestB, 'transfer-b', batchB, 1000]);

    const chain = fakeChain({
      async movements() {
        return { deposits: [], withdrawals: [], burns: [],
          batches: [{ hash: batchA, id: batchA, delta: -1000n }] };
      },
    });

    const report = await reconcileGatewayBalances(pool, chain, account, 1n, 100n);
    assert.equal(report.missingBatches.length, 0);
    assert.equal(report.batches.length, 1);
    assert.equal(report.batches[0]!.hash, batchA);
    const outcome = await runGatewayBalanceScan(pool, chain, account);
    assert.ok('scanId' in outcome);
    await pool.query('UPDATE gateway_payment_journal SET amount=999 WHERE request_id=$1', [requestA]);
    const replay = await replaySavedBalanceScan(pool, outcome.scanId);
    assert.equal(replay.report.balance.journalDebits, '1000', 'replay uses the captured journal, not changed live rows');
    assert.equal(replay.verified, true);
  });

  const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hash;
  const config = gatewayNetworkConfig('arcTestnet');
  const eventChain = (amount = 7n) => fakeChain({
    source: { kind: 'fixture', chainId: config.chainConfig.id },
    async totalBalance(_wallet, block) { return block >= 50n ? amount : 0n; },
    async movements() {
      return { deposits: [{ hash: hash(900), logIndex: 0, amount, evidence: {
        blockNumber: '50', blockHash: hash(50), address: config.domain.verifyingContract,
        topics: [hash(901)], data: '0x' as Hash,
      } }], withdrawals: [], burns: [], batches: [] };
    },
  });
  const readInput = async (id: string): Promise<BalanceSnapshot> =>
    (await pool.query('SELECT snapshot FROM gateway_balance_evidence WHERE scan_id=$1', [id])).rows[0].snapshot;

  await t.test('saves source logs and replays without RPC, Gateway or current purchase reads', async () => {
    const account = payer();
    const result = await runGatewayBalanceScan(pool, eventChain(), account);
    assert.ok('scanId' in result);
    const saved = await readInput(result.scanId);
    assert.equal(saved.source?.kind, 'fixture');
    assert.equal(saved.movements.deposits[0]?.evidence?.blockHash, hash(50));
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Network forbidden during replay'); };
    try {
      const replay = await replaySavedBalanceScan(pool, result.scanId);
      assert.equal(replay.verified, true);
      assert.equal(replay.report.balance.closing, '7');
      assert.equal(replay.report.status, 'MATCHED');
    } finally { globalThis.fetch = oldFetch; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await persistBalanceEvidence(client, result.scanId, saved);
      await persistBalanceEvidence(client, result.scanId, saved);
      await client.query('COMMIT');
    } finally { client.release(); }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gateway_balance_events WHERE payer=$1',
      [account.toLowerCase()])).rows[0].n, 1);
    await assert.rejects(pool.query('UPDATE gateway_balance_evidence SET digest=$2 WHERE scan_id=$1',
      [result.scanId, 'modified']), /append-only/);
    await assert.rejects(pool.query('DELETE FROM gateway_balance_events WHERE payer=$1',
      [account.toLowerCase()]), /append-only/);
  });

  await t.test('conflicting event rolls back result, evidence, cases and cursor, then retries', async () => {
    const account = payer();
    const row = (await eventChain().movements(account, 1n, 100n)).deposits[0]!;
    const payload = { kind: 'deposits', ...row, amount: '7' };
    await pool.query(`INSERT INTO gateway_balance_events(network,payer,transaction_hash,log_index,payload,digest)
      VALUES('arcTestnet',$1,$2,0,$3,$4)`, [account.toLowerCase(), row.hash, JSON.stringify(payload), evidenceDigest(payload)]);
    await assert.rejects(runGatewayBalanceScan(pool, eventChain(8n), account), /Conflicting chain event/);
    const { rows: [failed] } = await pool.query('SELECT id,status,result FROM gateway_balance_scans WHERE payer=$1', [account.toLowerCase()]);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.result, null);
    for (const table of ['gateway_balance_evidence', 'gateway_balance_discrepancies']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE scan_id=$1`, [failed.id])).rows[0].n, 0);
    }
    assert.equal((await pool.query('SELECT * FROM gateway_balance_cursors WHERE payer=$1', [account.toLowerCase()])).rowCount, 0);
    const recovered = await runGatewayBalanceScan(pool, eventChain(), account);
    assert.equal(recovered.status, 'matched');
    assert.ok('scanId' in recovered);
    assert.equal(recovered.scanId, failed.id);
    assert.equal((await replaySavedBalanceScan(pool, recovered.scanId)).verified, true);
  });

  await t.test('a disconnected evidence transaction rolls back and an expired lease recovers', async () => {
    const account = payer();
    let snapshot: BalanceSnapshot | undefined;
    await reconcileGatewayBalances(pool, eventChain(), account, 1n, 100n, fetch, (input) => { snapshot = input; });
    assert.ok(snapshot);
    const scanId = randomUUID();
    await pool.query(`INSERT INTO gateway_balance_scans(id,network,payer,from_block,to_block,status,lease_until)
      VALUES($1,'arcTestnet',$2,1,100,'running',now()-interval '1 minute')`, [scanId, account.toLowerCase()]);
    const client = await pool.connect();
    await client.query('BEGIN');
    await persistBalanceEvidence(client, scanId, snapshot);
    client.release(true); // Drop the connection without COMMIT, as in process loss.
    assert.equal((await pool.query('SELECT * FROM gateway_balance_evidence WHERE scan_id=$1', [scanId])).rowCount, 0);
    const recovered = await runGatewayBalanceScan(pool, eventChain(), account);
    assert.equal(recovered.status, 'matched');
    assert.equal((await replaySavedBalanceScan(pool, scanId)).verified, true);
  });

  await t.test('rejects canonical-header and previously stored finalized-hash conflicts', async () => {
    const account = payer();
    await assert.rejects(runGatewayBalanceScan(pool, { ...eventChain(),
      blockHash: async (n) => n === 50n ? hash(999) : hash(Number(n)),
    }, account), /not canonical/);
    await assert.rejects(runGatewayBalanceScan(pool, fakeChain({ blockHash: async () => hash(999) }), payer()),
      /Conflicting finalized block/);
  });

  await t.test('stale attempts cannot persist evidence or advance the cursor', async () => {
    const account = payer();
    const chain = eventChain();
    const moves = chain.movements;
    chain.movements = async (...args) => {
      await pool.query('UPDATE gateway_balance_scans SET attempts=attempts+1 WHERE payer=$1', [account.toLowerCase()]);
      return moves(...args);
    };
    await assert.rejects(runGatewayBalanceScan(pool, chain, account), /reclaimed/);
    const { rows: [scan] } = await pool.query('SELECT id,status FROM gateway_balance_scans WHERE payer=$1', [account.toLowerCase()]);
    assert.equal(scan.status, 'running');
    assert.equal((await pool.query('SELECT * FROM gateway_balance_evidence WHERE scan_id=$1', [scan.id])).rowCount, 0);
    assert.equal((await pool.query('SELECT * FROM gateway_balance_cursors WHERE payer=$1', [account.toLowerCase()])).rowCount, 0);
  });

  await t.test('rejects missing source logs and mainnet ingestion, without advancing', async () => {
    const chain = eventChain();
    chain.movements = async () => ({ deposits: [{ hash: hash(900), logIndex: 0, amount: 7n }],
      withdrawals: [], burns: [], batches: [] });
    await assert.rejects(runGatewayBalanceScan(pool, chain, payer()), /Missing chain log provenance/);
    await assert.rejects(runGatewayBalanceScan(pool, fakeChain({ network: 'arc' }), payer()), /testnet-only/);
  });

  await t.test('unknown/legacy evidence and tampered saved reports cannot pass replay', async () => {
    await assert.rejects(replaySavedBalanceScan(pool, randomUUID()), /no replay evidence/);
    const result = await runGatewayBalanceScan(pool, fakeChain(), payer());
    assert.ok('scanId' in result);
    assert.equal((await replaySavedBalanceScan(pool, result.scanId)).source, null);
    await pool.query(`UPDATE gateway_balance_scans SET result=jsonb_set(result,'{balance,closing}','"123"') WHERE id=$1`, [result.scanId]);
    await assert.rejects(replaySavedBalanceScan(pool, result.scanId), /differs from saved/);
    // Test the read boundary against corrupted storage without disabling DB guards.
    const snapshot = await readInput(result.scanId);
    const corruptedReader = { query: async () => ({ rows: [{ snapshot, digest: 'incorrect', result: {} }] }) } as unknown as Pool;
    await assert.rejects(replaySavedBalanceScan(corruptedReader, result.scanId), /digest mismatch/);
  });

  await t.test('real public testnet deposit survives database persistence and offline replay', async () => {
    const sample = JSON.parse(await readFile(new URL('../../docs/evidence/stage-5-live-balance.json', import.meta.url),'utf8'));
    assert.equal(sample.scope,'public-chain-only');
    assert.equal(sample.snapshot.ledgerScope,'none');
    assert.equal(sample.snapshot.source.kind,'rpc');
    assert.ok(sample.snapshot.movements.deposits.length > 0);
    assert.equal(evidenceDigest(sample.snapshot),sample.digest);
    const scanId = randomUUID(); const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO gateway_balance_scans(id,network,payer,from_block,to_block,status,result)
        VALUES($1,'arcTestnet',$2,$3,$4,'matched',$5)`,
      [scanId,sample.snapshot.payer,sample.snapshot.from,sample.snapshot.to,JSON.stringify(sample.result)]);
      await persistBalanceEvidence(client,scanId,sample.snapshot);
      await persistBalanceEvidence(client,scanId,sample.snapshot);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK');throw error; }
    finally {client.release();}
    const replay=await replaySavedBalanceScan(pool,scanId);
    assert.equal(replay.verified,true);
    assert.deepEqual(replay.report,sample.result);
    const events=await pool.query('SELECT * FROM gateway_balance_events WHERE payer=$1',[sample.snapshot.payer]);
    assert.equal(events.rowCount,sample.snapshot.movements.deposits.length);
    assert.equal(events.rows[0].payload.evidence.blockHash,sample.snapshot.closingHash);
  });

  await t.test('real public batch persists idempotently with raw-calldata validation on replay', async () => {
    const sample=JSON.parse(await readFile(new URL('../../docs/evidence/stage-5-live-batch.json',import.meta.url),'utf8'));
    const scanId=randomUUID();const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO gateway_balance_scans(id,network,payer,from_block,to_block,status,result)
        VALUES($1,'arcTestnet',$2,$3,$4,'discrepancy',$5)`,
      [scanId,sample.snapshot.payer,sample.snapshot.from,sample.snapshot.to,JSON.stringify(sample.result)]);
      await persistBalanceEvidence(client,scanId,sample.snapshot);
      await persistBalanceEvidence(client,scanId,sample.snapshot);
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    const replay=await replaySavedBalanceScan(pool,scanId);
    assert.equal(replay.batchValidation[0]!.status,'verified');
    assert.equal(replay.report.balance.chainDifference,'0');
    assert.deepEqual(replay.report,sample.result);
  });

});
