import type { PoolClient } from 'pg';

export interface AuditEntry {
  actor: string;
  action: string;
  entity: string;
  stateBefore?: string | null;
  stateAfter?: string | null;
}

// Append-only record. Call inside the transaction that performs the state change
// so the audit row and the change commit or roll back together.
export async function recordAudit(client: PoolClient, entry: AuditEntry) {
  await client.query(
    `INSERT INTO audit_history (actor, action, entity, state_before, state_after)
     VALUES ($1, $2, $3, $4, $5)`,
    [entry.actor, entry.action, entry.entity, entry.stateBefore ?? null, entry.stateAfter ?? null],
  );
}
