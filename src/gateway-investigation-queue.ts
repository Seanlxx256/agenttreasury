import type { Pool } from 'pg';
import { PaymentError } from './payments.js';

// A single SQL statement gives summary and page the same database snapshot and
// clock. No advisory locks or cached metrics are used to guess worker liveness.
export async function investigationRecoveryQueue(pool: Pool, after?: string) {
  const { rows: [result] } = await pool.query(`WITH pending AS NOT MATERIALIZED (
    SELECT id,request_id,status,created_at,last_checkpoint_at,attempts,model,refresh_external,
      jsonb_array_length(progress->'checks') AS saved_checks
    FROM gateway_investigation_checkpoints WHERE status='in-progress'
  ), page AS (
    SELECT id,request_id AS "requestId",status,created_at AS "createdAt",last_checkpoint_at AS "lastSavedAt",
      saved_checks AS "savedChecks",attempts,model,refresh_external AS "refreshExternal",
      greatest(0,extract(epoch FROM statement_timestamp()-created_at))::float8 AS "ageSeconds",
      CASE WHEN last_checkpoint_at IS NOT NULL THEN
        greatest(0,extract(epoch FROM statement_timestamp()-last_checkpoint_at))::float8 END AS "sinceLastSaveSeconds"
    FROM pending WHERE ($1::uuid IS NULL OR (created_at,id)>(
      SELECT created_at,id FROM gateway_investigation_checkpoints WHERE id=$1))
    ORDER BY created_at,id LIMIT 51
  ) SELECT statement_timestamp() AS "observedAt",
    ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM gateway_investigation_checkpoints WHERE id=$1)) AS "cursorFound",
    (SELECT jsonb_build_object('unfinishedCount',count(*)::int,'oldestCreatedAt',min(created_at),
      'oldestAgeSeconds',CASE WHEN count(*)>0 THEN greatest(0,extract(epoch FROM statement_timestamp()-min(created_at)))::float8 END,
      'longestSinceSaveSeconds',CASE WHEN min(last_checkpoint_at) IS NOT NULL THEN
        greatest(0,extract(epoch FROM statement_timestamp()-min(last_checkpoint_at)))::float8 END,
      'withoutSavedChecks',count(*) FILTER (WHERE saved_checks=0)::int,
      'savedTimeUnknown',count(*) FILTER (WHERE saved_checks>0 AND last_checkpoint_at IS NULL)::int) FROM pending) AS summary,
    (SELECT coalesce(jsonb_agg(page ORDER BY "createdAt",id),'[]'::jsonb) FROM page) AS checkpoints`, [after ?? null]);
  if (!result.cursorFound) throw new PaymentError(400, 'INVALID_INVESTIGATION_CURSOR');
  return { observedAt: result.observedAt, source: 'database', summary: result.summary,
    checkpoints: result.checkpoints.slice(0, 50), next: result.checkpoints.length > 50 ? result.checkpoints[49].id : null,
    executionState: 'unknown', limitation: 'Unfinished does not mean stopped. Resume checks the execution lock and snapshot; no automatic retry.' };
}
