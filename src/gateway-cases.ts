import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.js';
import { PaymentError } from './payments.js';
import { recordAudit } from './audit.js';

// Must be called in the scan transaction: evidence, case, cursor commit together.
export async function recordGatewayCase(client: PoolClient, scanId: string, kind: string, detail: unknown) {
  const { rows: [evidence] } = await client.query(`
    INSERT INTO gateway_balance_discrepancies(id, scan_id, kind, detail)
    VALUES($1, $2, $3, $4) ON CONFLICT(scan_id, kind, detail) DO NOTHING RETURNING id
  `, [randomUUID(), scanId, kind, JSON.stringify(detail)]);
  if (!evidence) return;
  const { rows: [scope] } = await client.query(`
    SELECT network, payer, gateway_case_subject($2, $3, from_block, to_block, $4) AS subject
    FROM gateway_balance_scans WHERE id = $1
  `, [scanId, kind, JSON.stringify(detail), evidence.id]);
  const { rows: [created] } = await client.query(`
    INSERT INTO gateway_reconciliation_cases(id, network, payer, kind, subject, latest_discrepancy_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(network,payer,kind,subject) DO NOTHING RETURNING id
  `, [randomUUID(), scope.network, scope.payer, kind, scope.subject, evidence.id]);
  const { rows: [current] } = await client.query(`
    SELECT c.*, d.detail = $5::jsonb AS unchanged
    FROM gateway_reconciliation_cases c JOIN gateway_balance_discrepancies d ON d.id = c.latest_discrepancy_id
    WHERE c.network=$1 AND c.payer=$2 AND c.kind=$3 AND c.subject=$4 FOR UPDATE OF c
  `, [scope.network, scope.payer, kind, scope.subject, JSON.stringify(detail)]);
  const reopened = !created && current.status === 'resolved' && !current.unchanged;
  if (!created) await client.query(`
    UPDATE gateway_reconciliation_cases SET version=version+1, latest_discrepancy_id=$2, last_seen_at=now(),
      status=CASE WHEN $3 THEN 'open' ELSE status END,
      resolved_at=CASE WHEN $3 THEN NULL ELSE resolved_at END WHERE id=$1
  `, [current.id, evidence.id, reopened]);
  await client.query('UPDATE gateway_balance_discrepancies SET case_id=$2 WHERE id=$1', [evidence.id, current.id]);
  await client.query(`
    INSERT INTO gateway_case_events(case_id,version,actor,event,status,note,evidence_id)
    SELECT id,version,'scanner',$2,status,$3,$4 FROM gateway_reconciliation_cases WHERE id=$1
  `, [current.id, created ? 'opened' : reopened ? 'reopened' : 'observed',
    reopened ? 'Changed evidence reopened the case.' : 'Scan evidence recorded.', evidence.id]);
}

export async function transitionGatewayCase(pool: Pool, id: string, input: {
  expectedVersion: number; status: 'investigating' | 'resolved'; note: string; evidenceId: string;
}, actor: 'operations' | 'finance') {
  return transaction(pool, async (client) => {
    const { rows: [current] } = await client.query('SELECT * FROM gateway_reconciliation_cases WHERE id=$1 FOR UPDATE', [id]);
    if (!current) throw new PaymentError(404, 'CASE_NOT_FOUND');
    if (current.version !== input.expectedVersion) throw new PaymentError(409, 'CASE_VERSION_CHANGED');
    if (current.latest_discrepancy_id !== input.evidenceId) throw new PaymentError(409, 'CASE_EVIDENCE_CHANGED');
    const allowed = input.status === 'investigating' ? ['open', 'resolved'] : ['investigating'];
    if (!allowed.includes(current.status)) throw new PaymentError(409, 'INVALID_CASE_TRANSITION');
    if (!input.note.trim()) throw new PaymentError(400, 'CASE_NOTE_REQUIRED');
    const { rows: [updated] } = await client.query(`
      UPDATE gateway_reconciliation_cases SET status=$2,version=version+1,
        resolved_at=CASE WHEN $2='resolved' THEN now() ELSE NULL END WHERE id=$1 RETURNING *
    `, [id, input.status]);
    await client.query(`
      INSERT INTO gateway_case_events(case_id,version,actor,event,status,note,evidence_id)
      VALUES($1,$2,$3,'transition',$4,$5,$6)
    `, [id, updated.version, actor, input.status, input.note.trim(), input.evidenceId]);
    await recordAudit(client, { actor, action:'gateway-case-transition', entity:id,
      stateBefore:JSON.stringify({ status:current.status,version:current.version }),
      stateAfter:JSON.stringify({ status:input.status,version:updated.version,evidenceId:input.evidenceId,note:input.note.trim() }),
    });
    return updated;
  });
}

export async function gatewayOperationsMetrics(pool: Pool) {
  // One statement gives all counters the same database snapshot.
  const { rows: [row] } = await pool.query(`SELECT now() AS "observedAt",
    (SELECT jsonb_build_object('open',count(*) FILTER(WHERE status='open'),
      'investigating',count(*) FILTER(WHERE status='investigating'),
      'resolved',count(*) FILTER(WHERE status='resolved'),
      'oldestUnresolvedSeconds',extract(epoch FROM now()-min(first_seen_at) FILTER(WHERE status<>'resolved')))
      FROM gateway_reconciliation_cases) AS cases,
    (SELECT jsonb_build_object('reserved',count(*) FILTER(WHERE budget_status='reserved'),
      'due',count(*) FILTER(WHERE budget_status='reserved' AND reconcile_review_at IS NULL AND reconcile_after<=now()
        AND (submitted_at IS NOT NULL OR signing_started_at IS NOT NULL OR authorized_at<=now()-interval '2 minutes')),
      'pausedForReview',count(*) FILTER(WHERE budget_status='reserved' AND reconcile_review_at IS NOT NULL),
      'oldestReservedSeconds',extract(epoch FROM now()-min(authorized_at) FILTER(WHERE budget_status='reserved')))
      FROM gateway_demo_purchases) AS recovery,
    (SELECT jsonb_build_object('unavailable',count(*) FILTER(WHERE evidence->>'status'='unavailable'),
      'conflict',count(*) FILTER(WHERE evidence->>'status'='conflict')) FROM
      (SELECT DISTINCT ON (o.request_id) o.evidence FROM gateway_payment_observations o
        JOIN gateway_demo_purchases p ON p.request_id=o.request_id
        WHERE p.budget_status='reserved' ORDER BY o.request_id,o.id DESC) latest) AS "latestRecoveryEvidence",
    (SELECT jsonb_build_object('failed',count(*) FILTER(WHERE status='failed'),
      'expiredLeases',count(*) FILTER(WHERE status='running' AND lease_until<=now()),
      'reclaims',coalesce(sum(attempts),0)) FROM gateway_balance_scans) AS scans,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('network',h.network,'payer',h.payer,
      'finalizedBlock',h.finalized_block::text,'nextBlock',c.next_block::text,
      'lagBlocks',CASE WHEN c.next_block IS NULL THEN NULL ELSE greatest(0,h.finalized_block-c.next_block+1)::text END,
      'headAgeSeconds',extract(epoch FROM now()-h.observed_at))), '[]'::jsonb)
      FROM gateway_balance_heads h LEFT JOIN gateway_balance_cursors c USING(network,payer)) AS wallets,
    (SELECT coalesce(jsonb_agg(to_jsonb(w) || jsonb_build_object('heartbeatAgeSeconds',
      extract(epoch FROM now()-w.heartbeat_at))), '[]'::jsonb) FROM gateway_worker_health w) AS workers`);
  return row;
}

export async function recordWorkerHeartbeat(pool: Pool, worker: string, success: boolean) {
  await pool.query(`INSERT INTO gateway_worker_health(worker,last_success_at,last_failure_at,consecutive_failures,failure_count)
    VALUES($1,CASE WHEN $2 THEN now() END,CASE WHEN NOT $2 THEN now() END,
      CASE WHEN $2 THEN 0 ELSE 1 END,CASE WHEN $2 THEN 0 ELSE 1 END)
    ON CONFLICT(worker) DO UPDATE SET heartbeat_at=now(),
      last_success_at=CASE WHEN $2 THEN now() ELSE gateway_worker_health.last_success_at END,
      last_failure_at=CASE WHEN NOT $2 THEN now() ELSE gateway_worker_health.last_failure_at END,
      consecutive_failures=CASE WHEN $2 THEN 0 ELSE gateway_worker_health.consecutive_failures+1 END,
      failure_count=gateway_worker_health.failure_count+CASE WHEN $2 THEN 0 ELSE 1 END`, [worker,success]);
}
