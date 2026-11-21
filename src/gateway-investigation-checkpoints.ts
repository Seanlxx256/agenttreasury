import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PaymentError } from './payments.js';
import { guidedChecklist, type GuidedProgress } from './gateway-guided-investigation.js';
import { collectInvestigationSnapshot, runGuidedInvestigation, type InvestigationRunOptions } from './gateway-investigation-run.js';

type Actor = 'operations' | 'finance';
type CheckpointReport = Awaited<ReturnType<typeof runGuidedInvestigation>> & { checkpointId: string };
type SavedRun = { runId: string; createdAt: Date; report: CheckpointReport };
type Checkpoint = {
  id: string; request_id: string; protocol: number; model: string | null; refresh_external: boolean;
  snapshot: Awaited<ReturnType<typeof collectInvestigationSnapshot>>; progress: GuidedProgress;
  status: 'in-progress' | 'finished'; run_id: string | null;
};

export async function createInvestigationCheckpoint(pool: Pool, requestId: string, actor: Actor,
  options: Pick<InvestigationRunOptions, 'model' | 'refreshExternal'> = {}) {
  const snapshot = await collectInvestigationSnapshot(pool, requestId), id = randomUUID();
  const progress: GuidedProgress = { version: 1, required: guidedChecklist(snapshot.facts).map((step) => step.kind), checks: [], turns: [] };
  await pool.query(`INSERT INTO gateway_investigation_checkpoints
    (id,request_id,actor,last_actor,model,refresh_external,snapshot,progress) VALUES($1,$2,$3,$3,$4,$5,$6,$7)`,
  [id,requestId,actor,options.model ?? null,options.refreshExternal === true,JSON.stringify(snapshot),JSON.stringify(progress)]);
  return id;
}

// Held session lock serializes one checkpoint, including its final report append.
// All snapshot reads borrow the lock connection, avoiding pool exhaustion when
// several investigations are active. No transaction spans model/network waits.
export async function resumeInvestigationCheckpoint(pool: Pool, requestId: string, id: string, actor: Actor,
  dependencies: Pick<InvestigationRunOptions, 'modelRequest' | 'gatewayRequest' | 'chainRead'> = {}) {
  const client = await pool.connect();
  // A connection loss must not become an unhandled EventEmitter error. Later
  // queries fail closed; this connection is never replaced during the run.
  const lost = () => {};
  client.on('error', lost);
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 90253)) AS acquired', [id]);
    if (!lock.acquired) throw new PaymentError(409, 'INVESTIGATION_BUSY');
    const { rows: [saved] } = await client.query<Checkpoint>(
      'SELECT * FROM gateway_investigation_checkpoints WHERE id=$1 AND request_id=$2', [id,requestId]);
    if (!saved) throw new PaymentError(404, 'INVESTIGATION_CHECKPOINT_NOT_FOUND');
    if (saved.status === 'finished') {
      const { rows: [run] } = await client.query<SavedRun>('SELECT id::text AS "runId",created_at AS "createdAt",report FROM gateway_investigation_runs WHERE id=$1', [saved.run_id]);
      if (!run) throw new PaymentError(409, 'INVESTIGATION_CHECKPOINT_INCOMPATIBLE');
      return { ...run.report, runId: run.runId, createdAt: run.createdAt };
    }
    if (saved.protocol !== 1 || saved.snapshot.requestId !== requestId) throw new PaymentError(409, 'INVESTIGATION_CHECKPOINT_INCOMPATIBLE');
    await client.query(`UPDATE gateway_investigation_checkpoints SET attempts=attempts+1,last_actor=$2,updated_at=now() WHERE id=$1`, [id,actor]);
    const result = await runGuidedInvestigation(saved.snapshot, () => collectInvestigationSnapshot(pool, requestId, client), {
      ...dependencies, model: saved.model ?? undefined, refreshExternal: saved.refresh_external, resume: saved.progress,
      checkpoint: async (progress) => {
        await client.query('UPDATE gateway_investigation_checkpoints SET progress=$2,updated_at=now() WHERE id=$1', [id,JSON.stringify(progress)]);
      },
    });
    const report = { ...result, checkpointId: id };
    // Report append and finished marker share one commit. An uncertain response
    // is safe to retry: either both persisted or neither did.
    await client.query('BEGIN');
    try {
      const { rows: [run] } = await client.query<Pick<SavedRun, 'runId' | 'createdAt'>>(`INSERT INTO gateway_investigation_runs(request_id,actor,model,report)
        VALUES($1,$2,$3,$4) RETURNING id::text AS "runId",created_at AS "createdAt"`, [requestId,actor,saved.model,JSON.stringify(report)]);
      if (!run) throw new Error('Investigation report was not saved');
      await client.query(`UPDATE gateway_investigation_checkpoints SET status='finished',run_id=$2,updated_at=now() WHERE id=$1`, [id,run.runId]);
      await client.query('COMMIT');
      return { ...report, ...run };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  } finally {
    // Destroy rather than return a session holding an advisory lock to the pool.
    client.release(true);
  }
}
