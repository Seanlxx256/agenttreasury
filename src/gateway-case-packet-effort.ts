import type { Pool } from 'pg';

export type ReviewTiming = {
  origin: 'interactive-declared' | 'simulation-declared';
  elapsedMs: number | null;
};
export type ReviewEffort = {
  version: 1;
  origin: ReviewTiming['origin'] | 'unclassified';
  elapsedMs: number | null;
  phase: 'first-review' | 'follow-up';
  model: string | null;
  modelStatus: string;
  topicsAdded: number;
  topicsRemoved: number;
  supplementsAdded: number;
  localRecordsChanged: number;
  timingScope: 'latest-display-to-submit';
  timingTrust: 'client-reported-unverified';
};

type Group = Pick<ReviewEffort, 'origin' | 'phase' | 'model' | 'modelStatus'> & {
  savedReviews: number; timedReviews: number; untimedReviews: number; medianElapsedMs: number | null;
  topicEdits: number; supplementsAdded: number; reviewsWithChangedRecords: number;
};

export function summarizeReviewEffort(rows: Array<{ packetId: string; effort: ReviewEffort | null }>, truncated: boolean) {
  const groups = new Map<string, Group & { times: number[] }>();
  let unmeasuredReviews = 0;
  for (const { effort } of rows) {
    if (!effort || effort.version !== 1) { unmeasuredReviews++; continue; }
    const dimensions = { origin: effort.origin, phase: effort.phase, model: effort.model, modelStatus: effort.modelStatus };
    const key = JSON.stringify(dimensions);
    const group = groups.get(key) ?? { ...dimensions, savedReviews: 0, timedReviews: 0, untimedReviews: 0,
      medianElapsedMs: null, topicEdits: 0, supplementsAdded: 0, reviewsWithChangedRecords: 0, times: [] };
    group.savedReviews++;
    // Missing timings are not zero and unclassified clients never enter timing comparisons.
    if (effort.origin !== 'unclassified' && Number.isInteger(effort.elapsedMs) && effort.elapsedMs! >= 0 && effort.elapsedMs! <= 3600000) {
      group.times.push(effort.elapsedMs!); group.timedReviews++;
    } else group.untimedReviews++;
    group.topicEdits += effort.topicsAdded + effort.topicsRemoved;
    group.supplementsAdded += effort.supplementsAdded;
    group.reviewsWithChangedRecords += Number(effort.localRecordsChanged > 0);
    groups.set(key, group);
  }
  return { schemaVersion: 1, window: { savedRevisions: rows.length, limit: 200, truncated,
    newestPacketId: rows[0]?.packetId ?? null, oldestPacketId: rows.at(-1)?.packetId ?? null },
  unmeasuredReviews,
  groups: [...groups.values()].map(({ times, ...group }) => {
    times.sort((a, b) => a - b); const middle = Math.floor(times.length / 2);
    return { ...group, medianElapsedMs: times.length ? (times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2) : null };
  }),
  scope: 'One request; latest 200 saved revisions. Failed submissions and abandoned reviews are not counted.',
  timing: 'Client-reported latest-display-to-submit elapsed time includes idle time and excludes initial preparation, generation and save latency. Reloads restart the timer. Not verified human work time.',
  conclusion: 'Descriptive telemetry only. Topic edits are not accuracy labels. No causal time savings, operator identity verification or quality improvement is established.' };
}

export async function readCasePacketEffort(pool: Pool, requestId: string) {
  const { rows } = await pool.query<{ packetId: string; effort: ReviewEffort | null }>(`SELECT id::text AS "packetId",report->'reviewEffort' AS effort
    FROM gateway_case_packets WHERE request_id=$1 AND report ? 'operatorReview' ORDER BY id DESC LIMIT 201`, [requestId]);
  return summarizeReviewEffort(rows.slice(0, 200), rows.length > 200);
}
