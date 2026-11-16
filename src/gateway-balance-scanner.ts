import { persistBalanceEvidence } from './gateway-balance-evidence.js';
import type { BalanceSnapshot } from './reconcile-gateway-balances.js';
import { recordGatewayCase } from './gateway-cases.js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { isAddress, type Address } from 'viem';
import { gatewayBalanceChain, type GatewayBalanceChain } from './gateway-balance-chain.js';
import { reconcileGatewayBalances } from './reconcile-gateway-balances.js';

const windowSize = 2000n;
const leaseSeconds = 600;

type ScanStatus = 'matched' | 'discrepancy' | 'failed';

export type GatewayBalanceScanOutcome =
  | { status: 'up-to-date'; network: string; payer: Address; nextBlock: string; finalized: string }
  | { status: 'already-running'; scanId: string; network: string; payer: Address; window: { from: string; to: string } }
  | { status: 'already-scanned'; scanId: string; network: string; payer: Address; window: { from: string; to: string } }
  | { status: ScanStatus; scanId: string; network: string; payer: Address; window: { from: string; to: string };
      discrepancies: number };

type Claim =
  | { status: 'claimed'; scanId: string; attempts: number; window: { from: string; to: string } }
  | { status: 'already-running'; scanId: string; window: { from: string; to: string } }
  | { status: 'already-scanned'; scanId: string; window: { from: string; to: string } }
  | { status: 'up-to-date'; nextBlock: string };

export async function runGatewayBalanceScan(
  pool: Pool, chain: GatewayBalanceChain, payer: Address, request: typeof fetch = fetch,
): Promise<GatewayBalanceScanOutcome> {
  if (chain.network !== 'arcTestnet') throw new Error('Balance scan ingestion is testnet-only');
  const wallet = payer.toLowerCase() as Address;
  const network = chain.network;
  const finalized = await chain.finalized();

  await pool.query(`INSERT INTO gateway_balance_heads(network,payer,finalized_block)
    VALUES($1,$2,$3) ON CONFLICT(network,payer) DO UPDATE
    SET finalized_block=EXCLUDED.finalized_block, observed_at=now()`, [network,wallet,String(finalized)]);
  const claim = await claimScan(pool, network, wallet, finalized, leaseSeconds);
  if (claim.status === 'already-running' || claim.status === 'already-scanned') {
    return { status: claim.status, scanId: claim.scanId, network, payer: wallet, window: claim.window };
  }
  if (claim.status === 'up-to-date') {
    return { status: 'up-to-date', network, payer: wallet, nextBlock: claim.nextBlock, finalized: String(finalized) };
  }
  const { scanId, attempts, window } = claim;
  const fromBlock = BigInt(window.from);
  const toBlock = BigInt(window.to);

  let snapshot: BalanceSnapshot | undefined;
  let discrepancies: number;
  let report: Awaited<ReturnType<typeof reconcileGatewayBalances>>;
  try {
    report = await reconcileGatewayBalances(pool, chain, payer, fromBlock, toBlock, request, (input) => { snapshot = input; });
    if (!snapshot) throw new Error('Missing balance scan inputs');
    discrepancies = await persistScanResult(pool, scanId, attempts, report, network, wallet, toBlock, snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markScanFailed(pool, scanId, attempts, message);
    throw error;
  }

  return {
    status: report.status === 'MATCHED' ? 'matched' : 'discrepancy',
    scanId, network, payer: wallet, window, discrepancies,
  };
}

// Claim the (network, payer) execution right and decide the scan window inside a
// transaction serialized by an advisory lock keyed on (network, payer). Reading
// the cursor and the unfinished-window state under the same lock is what makes
// the decision correct across processes:
//
// - an active running scan with a live lease always wins;
// - otherwise the OLDEST unfinished window (failed, or running with an expired
//   lease) is recovered first, so a failed first scan is resumed at its original
//   start instead of recomputing a fresh window from the latest finalized height
//   and silently skipping the failed window's head;
// - only when no unfinished window exists is a new window derived from the
//   cursor (or the tail of the chain on the very first run).
//
// Recovering a window bumps its `attempts`, which is the wallet-scoped execution
// token: a stale runner holding the previous `attempts` value can no longer mark
// the scan failed or persist a result. Combined with the monotonic cursor
// advance below, an old process can never rewind a cursor a newer process moved.
async function claimScan(
  pool: Pool, network: string, payer: Address, finalized: bigint, leaseSeconds: number,
): Promise<Claim> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [network, payer]);

    const { rows: [active] } = await client.query<{ id: string; from_block: string; to_block: string }>(`
      SELECT id, from_block::text AS from_block, to_block::text AS to_block
      FROM gateway_balance_scans
      WHERE network = $1 AND payer = $2 AND status = 'running' AND lease_until > now()
      ORDER BY started_at DESC LIMIT 1
    `, [network, payer]);
    if (active) {
      await client.query('COMMIT');
      return { status: 'already-running', scanId: active.id,
        window: { from: active.from_block, to: active.to_block } };
    }

    const { rows: [unfinished] } = await client.query<{ id: string; from_block: string; to_block: string }>(`
      SELECT id, from_block::text AS from_block, to_block::text AS to_block
      FROM gateway_balance_scans
      WHERE network = $1 AND payer = $2
        AND (status = 'failed' OR (status = 'running' AND lease_until <= now()))
      ORDER BY from_block ASC LIMIT 1
    `, [network, payer]);

    if (unfinished) {
      const { rows: [claimed] } = await client.query<{ id: string; attempts: number }>(`
        UPDATE gateway_balance_scans
        SET attempts = attempts + 1, status = 'running', error = NULL,
            lease_until = now() + $2 * interval '1 second', started_at = now()
        WHERE id = $1 AND (status = 'failed' OR (status = 'running' AND lease_until <= now()))
        RETURNING id, attempts
      `, [unfinished.id, leaseSeconds]);
      if (!claimed) {
        await client.query('COMMIT');
        return { status: 'already-running', scanId: unfinished.id,
          window: { from: unfinished.from_block, to: unfinished.to_block } };
      }
      await client.query('COMMIT');
      return { status: 'claimed', scanId: claimed.id, attempts: claimed.attempts,
        window: { from: unfinished.from_block, to: unfinished.to_block } };
    }

    // No unfinished window: derive the next window from the cursor under the lock.
    const { rows: [cursorRow] } = await client.query<{ next_block: string }>(
      'SELECT next_block::text FROM gateway_balance_cursors WHERE network = $1 AND payer = $2',
      [network, payer],
    );
    let fromBlock = cursorRow ? BigInt(cursorRow.next_block)
      : (finalized - windowSize + 1n > 1n ? finalized - windowSize + 1n : 1n);
    if (fromBlock < 1n) fromBlock = 1n;
    if (fromBlock > finalized) {
      await client.query('COMMIT');
      return { status: 'up-to-date', nextBlock: String(fromBlock) };
    }
    const toBlock = finalized < fromBlock + windowSize - 1n ? finalized : fromBlock + windowSize - 1n;

    const { rows: [existing] } = await client.query<{ id: string; status: string }>(`
      SELECT id, status FROM gateway_balance_scans
      WHERE network = $1 AND payer = $2 AND from_block = $3 AND to_block = $4
    `, [network, payer, fromBlock, toBlock]);
    if (existing && (existing.status === 'matched' || existing.status === 'discrepancy')) {
      await client.query('COMMIT');
      return { status: 'already-scanned', scanId: existing.id,
        window: { from: String(fromBlock), to: String(toBlock) } };
    }

    const scanId = randomUUID();
    await client.query(`
      INSERT INTO gateway_balance_scans (id, network, payer, from_block, to_block, status, lease_until)
      VALUES ($1, $2, $3, $4, $5, 'running', now() + $6 * interval '1 second')
    `, [scanId, network, payer, fromBlock, toBlock, leaseSeconds]);
    await client.query('COMMIT');
    return { status: 'claimed', scanId, attempts: 0,
      window: { from: String(fromBlock), to: String(toBlock) } };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function markScanFailed(pool: Pool, scanId: string, attempts: number, message: string) {
  // `attempts` is the execution token: if the row was reclaimed, the old runner
  // must not mark the new runner's work as failed.
  await pool.query(`
    UPDATE gateway_balance_scans
    SET status = 'failed', error = $2, finished_at = now(), lease_until = now()
    WHERE id = $1 AND attempts = $3
  `, [scanId, message, attempts]);
}

async function persistScanResult(
  pool: Pool, scanId: string, attempts: number, report: Awaited<ReturnType<typeof reconcileGatewayBalances>>,
  network: string, payer: Address, toBlock: bigint, snapshot: BalanceSnapshot,
) {
  const discrepancies: Array<{ kind: string; detail: unknown }> = [];
  if (report.balance.chainDifference !== '0' || report.balance.journalDifference !== '0') {
    discrepancies.push({ kind: 'balance', detail: {
      chainDifference: report.balance.chainDifference, journalDifference: report.balance.journalDifference,
      opening: report.balance.opening, closing: report.balance.closing,
      chainClosing: report.balance.chainClosing, journalClosing: report.balance.journalClosing,
    } });
  }
  for (const batch of report.batches.filter((row) => row.status === 'DISCREPANCY')) {
    discrepancies.push({ kind: 'batch', detail: batch });
  }
  for (const missing of report.missingBatches) {
    discrepancies.push({ kind: 'missing-batch', detail: missing });
  }
  for (const unresolved of report.currentAuthorizations.unresolved) {
    discrepancies.push({ kind: 'unresolved-authorization', detail: unresolved });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Persist the scan status, its work orders, and the cursor advance in one
    // transaction. The attempts guard rejects a runner whose row was reclaimed,
    // so a stale runner can never leave a half-finished scan behind.
    const updated = await client.query(`
      UPDATE gateway_balance_scans
      SET status = $3, result = $4, finished_at = now(), lease_until = now()
      WHERE id = $1 AND attempts = $2
    `, [scanId, attempts, report.status === 'MATCHED' ? 'matched' : 'discrepancy', JSON.stringify(report)]);
    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK');
      throw new Error('Balance scan was reclaimed before its result could be persisted');
    }
    await persistBalanceEvidence(client, scanId, snapshot);
    for (const { kind, detail } of discrepancies) {
      await recordGatewayCase(client, scanId, kind, detail);
    }
    // GREATEST makes the cursor monotonic: even if a stale runner somehow
    // persists after a newer window advanced it, the cursor never rewinds.
    await client.query(`
      INSERT INTO gateway_balance_cursors (network, payer, next_block)
      VALUES ($1, $2, $3)
      ON CONFLICT (network, payer) DO UPDATE
      SET next_block = GREATEST(gateway_balance_cursors.next_block, EXCLUDED.next_block),
          updated_at = now()
    `, [network, payer, String(toBlock + 1n)]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return discrepancies.length;
}

export async function gatewayBalanceScanMetrics(pool: Pool, payer?: Address) {
  const latestParams: unknown[] = [];
  const openParams: unknown[] = [];
  if (payer) {
    latestParams.push(payer.toLowerCase());
    openParams.push(payer.toLowerCase());
  }
  const { rows: [latest] } = await pool.query(`
    SELECT status, network, from_block::text AS "fromBlock", to_block::text AS "toBlock", finished_at AS "finishedAt", result
    FROM gateway_balance_scans
    ${payer ? 'WHERE payer = $1' : ''}
    ORDER BY finished_at DESC NULLS LAST, to_block DESC LIMIT 1
  `, latestParams);
  const { rows: openByKind } = await pool.query(`
    SELECT d.kind, count(*)::int AS count
    FROM gateway_reconciliation_cases d
    ${payer ? "WHERE d.status <> 'resolved' AND d.payer = $1" : "WHERE d.status <> 'resolved'"}
    GROUP BY d.kind ORDER BY d.kind
  `, openParams);
  return {
    latestScan: latest ? {
      status: latest.status, network: latest.network,
      window: { from: latest.fromBlock, to: latest.toBlock }, finishedAt: latest.finishedAt,
    } : null,
    openDiscrepancies: Object.fromEntries(openByKind.map((row: { kind: string; count: number }) => [row.kind, row.count])),
    totalOpenDiscrepancies: openByKind.reduce((sum: number, row: { count: number }) => sum + row.count, 0),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [payer, ...extra] = process.argv.slice(2);
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL || !payer || !isAddress(payer) || extra.length) {
    throw new Error('Set DATABASE_URL and run npm run scan:gateway-balances -- <payer>');
  }
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  try {
    const outcome = await runGatewayBalanceScan(pool, await gatewayBalanceChain(), payer);
    console.log(JSON.stringify({ ...outcome, metrics: await gatewayBalanceScanMetrics(pool, payer) }, null, 2));
    if (outcome.status === 'discrepancy') process.exitCode = 2;
  } finally {
    await pool.end();
  }
}
