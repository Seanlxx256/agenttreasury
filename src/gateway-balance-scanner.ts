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

  const scanId = randomUUID();
  const inserted = await pool.query<{ id: string }>(`
    INSERT INTO gateway_balance_scans (id, network, payer, from_block, to_block, status, lease_until)
    VALUES ($1, $2, $3, $4, $5, 'running', now() + $6 * interval '1 second')
    ON CONFLICT (network, payer, from_block, to_block) DO NOTHING
    RETURNING id
  `, [scanId, network, wallet, fromBlock, toBlock, leaseSeconds]);

  let claimedId: string;
  if (inserted.rows[0]?.id) {
    claimedId = inserted.rows[0].id;
  } else {
    const { rows } = await pool.query<{ id: string; status: string; lease_until: Date }>(`
      SELECT id, status, lease_until FROM gateway_balance_scans
      WHERE network = $1 AND payer = $2 AND from_block = $3 AND to_block = $4
    `, [network, wallet, fromBlock, toBlock]);
    const existing = rows[0];
    if (!existing) throw new Error('Concurrent balance scan row disappeared');
    if (existing.status !== 'running' || existing.lease_until > new Date()) {
      return existing.status === 'running'
        ? { status: 'already-running', scanId: existing.id, network, payer: wallet, window }
        : { status: 'already-scanned', scanId: existing.id, network, payer: wallet, window };
    }
    await pool.query(`
      UPDATE gateway_balance_scans
      SET attempts = attempts + 1, lease_until = now() + $4 * interval '1 second', status = 'running'
      WHERE id = $1 AND status = 'running' AND lease_until <= now() AND network = $2 AND payer = $3
    `, [existing.id, network, wallet, leaseSeconds]);
    claimedId = existing.id;
  }

  let report: Awaited<ReturnType<typeof reconcileGatewayBalances>>;
  try {
    report = await reconcileGatewayBalances(pool, chain, payer, fromBlock, toBlock, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE gateway_balance_scans SET status = 'failed', error = $2, finished_at = now(), lease_until = now()
       WHERE id = $1`, [claimedId, message]);
    throw error;
  }

  const discrepancies = await persistScanResult(pool, claimedId, report, network, wallet);
  return {
    status: report.status === 'MATCHED' ? 'matched' : 'discrepancy',
    scanId: claimedId, network, payer: wallet, window, discrepancies,
  };
}

async function persistScanResult(
  pool: Pool, scanId: string, report: Awaited<ReturnType<typeof reconcileGatewayBalances>>,
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

  await pool.query(
    `UPDATE gateway_balance_scans SET status = $2, result = $3, finished_at = now(), lease_until = now() WHERE id = $1`,
    [scanId, report.status === 'MATCHED' ? 'matched' : 'discrepancy', JSON.stringify(report)],
  );
  for (const { kind, detail } of discrepancies) {
    await pool.query(`
      INSERT INTO gateway_balance_discrepancies (id, scan_id, kind, detail)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (scan_id, kind, detail) DO NOTHING
    `, [randomUUID(), scanId, kind, JSON.stringify(detail)]);
  }
  await pool.query(`
    INSERT INTO gateway_balance_cursors (network, payer, next_block)
    VALUES ($1, $2, $3)
    ON CONFLICT (network, payer) DO UPDATE SET next_block = EXCLUDED.next_block, updated_at = now()
  `, [network, payer, String(BigInt(report.window.to) + 1n)]);

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
