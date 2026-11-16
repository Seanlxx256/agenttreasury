import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface AuditEntry {
  actor: string;
  action: string;
  entity: string;
  stateBefore?: string | null;
  stateAfter?: string | null;
}

// The audit history is append-only by convention, but convention alone trusts the
// database. The hash chain makes it tamper-evident: every entry hashes its own
// fields plus the previous entry's hash, so editing or reordering any row breaks
// every hash after it, and a reader can detect that without trusting the writer.
// The advisory lock serializes audit insertion across concurrent transactions so
// the chain can never fork.
const auditAdvisoryLock = 745314;

function auditEntryHash(fields: {
  occurredAt: Date;
  actor: string;
  action: string;
  entity: string;
  stateBefore: string | null;
  stateAfter: string | null;
  prevHash: string | null;
}): string {
  const payload = [
    fields.occurredAt.toISOString(),
    fields.actor,
    fields.action,
    fields.entity,
    fields.stateBefore,
    fields.stateAfter,
    fields.prevHash,
  ].join('\u0000');
  return createHash('sha256').update(payload).digest('hex');
}

// Append-only record. Call inside the transaction that performs the state change
// so the audit row and the change commit or roll back together.
export async function recordAudit(client: PoolClient, entry: AuditEntry) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [auditAdvisoryLock]);
  const { rows: [previous] } = await client.query<{ entryHash: string }>(
    'SELECT entry_hash AS "entryHash" FROM audit_history WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1',
  );
  const prevHash = previous?.entryHash ?? null;
  const occurredAt = new Date();
  const entryHash = auditEntryHash({
    occurredAt, actor: entry.actor, action: entry.action, entity: entry.entity,
    stateBefore: entry.stateBefore ?? null, stateAfter: entry.stateAfter ?? null, prevHash,
  });
  await client.query(
    `INSERT INTO audit_history (actor, action, entity, state_before, state_after, occurred_at, entry_hash, prev_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [entry.actor, entry.action, entry.entity, entry.stateBefore ?? null, entry.stateAfter ?? null,
      occurredAt, entryHash, prevHash],
  );
}

export interface AuditChainVerification {
  verified: boolean;
  entries: number;
  firstBrokenId: number | null;
  reason: string | null;
}

// Walks the chain from its first hashed row and recomputes every hash. A NULL
// hashed prefix (rows written before the chain existed) is outside the chain and
// is not verified.
export async function verifyAuditChain(pool: Pool): Promise<AuditChainVerification> {
  const { rows } = await pool.query<{
    id: number; actor: string; action: string; entity: string;
    stateBefore: string | null; stateAfter: string | null;
    occurredAt: Date; entryHash: string; prevHash: string | null;
  }>(`
    SELECT id, actor, action, entity, state_before AS "stateBefore", state_after AS "stateAfter",
      occurred_at AS "occurredAt", entry_hash AS "entryHash", prev_hash AS "prevHash"
    FROM audit_history WHERE entry_hash IS NOT NULL ORDER BY id
  `);
  if (rows.length === 0) return { verified: true, entries: 0, firstBrokenId: null, reason: 'empty-chain' };
  let expectedPrev: string | null = null;
  for (const row of rows) {
    if (row.prevHash !== expectedPrev) {
      return { verified: false, entries: rows.length, firstBrokenId: row.id, reason: 'prev-hash-mismatch' };
    }
    const expected = auditEntryHash({
      occurredAt: row.occurredAt, actor: row.actor, action: row.action, entity: row.entity,
      stateBefore: row.stateBefore, stateAfter: row.stateAfter, prevHash: row.prevHash,
    });
    if (row.entryHash !== expected) {
      return { verified: false, entries: rows.length, firstBrokenId: row.id, reason: 'entry-hash-mismatch' };
    }
    expectedPrev = row.entryHash;
  }
  return { verified: true, entries: rows.length, firstBrokenId: null, reason: null };
}
