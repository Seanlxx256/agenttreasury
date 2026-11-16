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
  | { status: 'claimed'; scanId: string; attempts: number }
  | { status: 'already-running'; scanId: string; window: { from: string; to: string } }
  | { status: 'already-scanned'; scanId: string; window: { from: string; to: string } };

export async function runGatewayBalanceScan(
  pool: Pool, chain: GatewayBalanceChain, payer: Address, request: typeof fetch = fetch,
): Promise<GatewayBalanceScanOutcome> {
  const wallet = payer.toLowerCase() as Address;
  const network = chain.network;
  const finalized = await chain.finalized();

  const { rows: [cursorRow] } = await pool.query<{ next_block: string }>(
    'SELECT next_block::text FROM gateway_balance_cursors WHERE network = $1 AND payer = $2',
    [network, wallet],
  );
  let fromBlock = cursorRow ? BigInt(cursorRow.next_block) : (finalized - windowSize + 1n > 1n ? finalized - windowSize + 1n : 1n);
  if (fromBlock < 1n) fromBlock = 1n;
  if (fromBlock > finalized) {
    return { status: 'up-to-date', network, payer: wallet, nextBlock: String(fromBlock), finalized: String(finalized) };
  }
  const toBlock = finalized < fromBlock + windowSize - 1n ? finalized : fromBlock + windowSize - 1n;
  const window = { from: String(fromBlock), to: String(toBlock) };

  const claim = await claimScan(pool, network, wallet, fromBlock, toBlock, leaseSeconds);
  if (claim.status === 'already-running' || claim.status === 'already-scanned') {
    return { status: claim.status, scanId: claim.scanId, network, payer: wallet, window: claim.window };
  }
  const { scanId, attempts } = claim;

  let report: Awaited<ReturnType<typeof reconcileGatewayBalances>>;
  try {
    report = await reconcileGatewayBalances(pool, chain, payer, fromBlock, toBlock, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markScanFailed(pool, scanId, attempts, message);
    throw error;
  }

  const discrepancies = await persistScanResult(pool, scanId, attempts, report, network, wallet);
  return {
    status: report.status === 'MATCHED' ? 'matched' : 'discrepancy',
    scanId, network, payer: wallet, window, discrepancies,
  };
}

// Claim the (network, payer) execution right inside a transaction serialized by
// an advisory lock keyed on (network, payer). The lock makes the active-window
// check and the insert/claim atomic, so two processes cannot start overlapping
// windows for the same wallet even when the finalized height changes the window
// bounds between runs.
async function claimScan(
  pool: Pool, network: string, payer: Address, fromBlock: bigint, toBlock: bigint, leaseSeconds: number,
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

    const { rows } = await client.query<{ id: string; status: string }>(`
      SELECT id, status FROM gateway_balance_scans
      WHERE network = $1 AND payer = $2 AND from_block = $3 AND to_block = $4
    `, [network, payer, fromBlock, toBlock]);
    const existing = rows[0];

    let scanId: string;
    let attempts: number;
    if (!existing) {
      scanId = randomUUID();
      attempts = 0;
      await client.query(`
        INSERT INTO gateway_balance_scans (id, network, payer, from_block, to_block, status, lease_until)
        VALUES ($1, $2, $3, $4, $5, 'running', now() + $6 * interval '1 second')
      `, [scanId, network, payer, fromBlock, toBlock, leaseSeconds]);
    } else if (existing.status === 'failed' || existing.status === 'running') {
      // A failed scan is retryable; a running scan is reclaimable only after its
      // lease expired. The UPDATE ... RETURNING decides the single winner, so a
      // losing process never proceeds.
      const { rows: [claimed] } = await client.query<{ id: string; attempts: number }>(`
        UPDATE gateway_balance_scans
        SET attempts = attempts + 1, status = 'running', error = NULL,
            lease_until = now() + $2 * interval '1 second', started_at = now()
        WHERE id = $1 AND (status = 'failed' OR (status = 'running' AND lease_until <= now()))
        RETURNING id, attempts
      `, [existing.id, leaseSeconds]);
      if (!claimed) {
        await client.query('COMMIT');
        return { status: 'already-running', scanId: existing.id,
          window: { from: String(fromBlock), to: String(toBlock) } };
      }
      scanId = claimed.id;
      attempts = claimed.attempts;
    } else {
      await client.query('COMMIT');
      return { status: 'already-scanned', scanId: existing.id,
        window: { from: String(fromBlock), to: String(toBlock) } };
    }

    await client.query('COMMIT');
    return { status: 'claimed', scanId, attempts };
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
  network: string, payer: Address,
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
    for (const { kind, detail } of discrepancies) {
      await client.query(`
        INSERT INTO gateway_balance_discrepancies (id, scan_id, kind, detail)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (scan_id, kind, detail) DO NOTHING
      `, [randomUUID(), scanId, kind, JSON.stringify(detail)]);
    }
    await client.query(`
      INSERT INTO gateway_balance_cursors (network, payer, next_block)
      VALUES ($1, $2, $3)
      ON CONFLICT (network, payer) DO UPDATE SET next_block = EXCLUDED.next_block, updated_at = now()
    `, [network, payer, String(BigInt(report.window.to) + 1n)]);
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
    FROM gateway_balance_discrepancies d JOIN gateway_balance_scans s ON s.id = d.scan_id
    ${payer ? "WHERE d.status = 'open' AND s.payer = $1" : "WHERE d.status = 'open'"}
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
