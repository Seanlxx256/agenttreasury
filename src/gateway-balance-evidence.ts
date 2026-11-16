import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { replayBalanceSnapshot, type BalanceSnapshot } from './reconcile-gateway-balances.js';
import { gatewayNetworkConfig } from './gateway-x402.js';

// Stable across JSONB round trips, which can reorder object properties.
export function evidenceDigest(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item !== null && typeof item === 'object') return `{${Object.entries(item)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(',')}}`;
    return JSON.stringify(item);
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}

// Called inside the scanner transaction after its attempt fencing check.
export async function persistBalanceEvidence(client: PoolClient, scanId: string, input: BalanceSnapshot) {
  if (input.network !== 'arcTestnet') throw new Error('Balance evidence ingestion is testnet-only');
  const config = gatewayNetworkConfig(input.network);
  const blocks = new Map<string, string>();
  const block = (height: string, hash: string) => {
    if (blocks.has(height) && blocks.get(height) !== hash) throw new Error('Conflicting finalized block evidence');
    blocks.set(height, hash);
  };
  block(String(BigInt(input.from) - 1n), input.openingHash);
  block(input.to, input.closingHash);
  if (input.source && input.source.chainId !== config.chainConfig.id) throw new Error('Evidence chain ID mismatch');
  for (const [kind, rows] of Object.entries(input.movements)) {
    for (const row of rows) {
      const log = row.evidence;
      if (!log) {
        if (input.source) throw new Error('Missing chain log provenance');
        continue; // Legacy adapters remain explicitly unattributed.
      }
      if (!input.source || row.logIndex === undefined || !Number.isSafeInteger(row.logIndex) || row.logIndex < 0 ||
          log.address.toLowerCase() !== config.domain.verifyingContract.toLowerCase() ||
          BigInt(log.blockNumber) < BigInt(input.from) || BigInt(log.blockNumber) > BigInt(input.to) ||
          (kind === 'batches' && !log.transactionInput)) throw new Error('Invalid chain log provenance');
      block(log.blockNumber, log.blockHash);
      const payload = { kind, ...row };
      const digest = evidenceDigest(payload);
      const key = [input.network, input.payer, row.hash, row.logIndex];
      await client.query(`INSERT INTO gateway_balance_events(network,payer,transaction_hash,log_index,payload,digest)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [...key, JSON.stringify(payload), digest]);
      const { rows: [saved] } = await client.query(`SELECT digest FROM gateway_balance_events
        WHERE network=$1 AND payer=$2 AND transaction_hash=$3 AND log_index=$4`, key);
      if (saved?.digest !== digest) throw new Error('Conflicting chain event evidence');
    }
  }
  // Global network checkpoints detect a changed finalized hash even across wallets.
  for (const [height, hash] of [...blocks].sort(([a], [b]) => BigInt(a) < BigInt(b) ? -1 : 1)) {
    await client.query(`INSERT INTO gateway_balance_blocks(network,block_number,block_hash)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [input.network, height, hash]);
    const { rows: [saved] } = await client.query(`SELECT block_hash FROM gateway_balance_blocks
      WHERE network=$1 AND block_number=$2`, [input.network, height]);
    if (saved?.block_hash !== hash) throw new Error('Conflicting finalized block evidence');
  }
  const digest = evidenceDigest(input);
  await client.query(`INSERT INTO gateway_balance_evidence(scan_id,version,snapshot,digest)
    VALUES($1,1,$2,$3) ON CONFLICT DO NOTHING`, [scanId, JSON.stringify(input), digest]);
  const { rows: [saved] } = await client.query('SELECT digest FROM gateway_balance_evidence WHERE scan_id=$1', [scanId]);
  if (saved?.digest !== digest) throw new Error('Conflicting scan input evidence');
}

export async function replaySavedBalanceScan(pool: Pool, scanId: string) {
  const { rows: [saved] } = await pool.query<{ snapshot: BalanceSnapshot; digest: string; result: unknown }>(`
    SELECT e.snapshot,e.digest,s.result FROM gateway_balance_evidence e
    JOIN gateway_balance_scans s ON s.id=e.scan_id WHERE e.scan_id=$1`, [scanId]);
  if (!saved) throw new Error('Scan has no replay evidence (unknown or legacy scan)');
  if (evidenceDigest(saved.snapshot) !== saved.digest) throw new Error('Balance evidence digest mismatch');
  const report = replayBalanceSnapshot(saved.snapshot);
  if (evidenceDigest(report) !== evidenceDigest(saved.result)) throw new Error('Replayed report differs from saved result');
  return { scanId, verified: true, source: saved.snapshot.source, digest: saved.digest, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [scanId, ...extra] = process.argv.slice(2);
  if (!process.env.DATABASE_URL || !scanId || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(scanId) || extra.length) {
    throw new Error('Set DATABASE_URL and run npm run replay:gateway-balances -- <scan-id>');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000,
    options: '-c default_transaction_read_only=on' });
  try { console.log(JSON.stringify(await replaySavedBalanceScan(pool, scanId), null, 2)); }
  finally { await pool.end(); }
}
