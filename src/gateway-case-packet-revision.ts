import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assembleCasePacket, type PacketIssue, type PacketSource, type collectPacketSources } from './gateway-case-packet.js';
import type { ReviewEffort, ReviewTiming } from './gateway-case-packet-effort.js';
import { PaymentError } from './payments.js';

type Packet = ReturnType<typeof assembleCasePacket>;
export type PacketReview = { timing?: ReviewTiming; expectedPacketId: string; topics: PacketIssue['topic'][]; note: string;
  supplements: Array<{ kind: 'merchant-reply' | 'customer-reply' | 'operator-observation'; reference: string; text: string }> };

export function reviseCasePacket(previous: Packet & { operatorReview?: { topics: PacketIssue['topic'][] } },
  snapshot: Awaited<ReturnType<typeof collectPacketSources>>, input: PacketReview, actor: string) {
  const enteredAt = new Date().toISOString();
  const inherited = previous.sources.filter((source) => source.id.startsWith('supplement-'));
  if (inherited.length + input.supplements.length > 30) throw new PaymentError(409, 'CASE_PACKET_SUPPLEMENT_LIMIT');
  const added: PacketSource[] = input.supplements.map((item) => ({ id: `supplement-${randomUUID()}`, kind: 'party-claim',
    locator: `operator-entered:${item.kind}`, data: { ...item, enteredByRole: actor, enteredAt,
      identityVerified: false, verification: 'unverified' } }));
  const statements = { customerStatement: String(previous.partyStatements.find((s) => s.id === 'statement-customer')?.data.text ?? ''),
    merchantStatement: String(previous.partyStatements.find((s) => s.id === 'statement-merchant')?.data.text ?? '') };
  const report = assembleCasePacket(snapshot, statements, previous.modelInterpretation,
    { topics: input.topics, supplements: [...inherited, ...added], interpretationSources: previous.interpretationSources ?? previous.partyStatements });
  const oldTopics = previous.operatorReview?.topics ?? previous.selectedTopics ?? [...new Set([...previous.ruleIssues.issues, ...previous.modelInterpretation.issues].map((i) => i.topic))];
  const oldSources = new Map(previous.snapshot.sources.map((s) => [s.id, s]));
  const newSources = new Map(snapshot.sources.map((s) => [s.id, s]));
  const topicsAdded = input.topics.filter((topic) => !oldTopics.includes(topic));
  const topicsRemoved = oldTopics.filter((topic) => !input.topics.includes(topic));
  const recordsAdded = [...newSources.keys()].filter((id) => !oldSources.has(id));
  const recordsRemoved = [...oldSources.keys()].filter((id) => !newSources.has(id));
  const recordsChanged = [...newSources.keys()].filter((id) => oldSources.has(id) && !isDeepStrictEqual(
    JSON.parse(JSON.stringify(oldSources.get(id))), JSON.parse(JSON.stringify(newSources.get(id)))));
  const reviewEffort: ReviewEffort = { version: 1, origin: input.timing?.origin ?? 'unclassified', elapsedMs: input.timing?.elapsedMs ?? null,
    phase: previous.operatorReview ? 'follow-up' : 'first-review', model: previous.modelInterpretation.model,
    modelStatus: previous.modelInterpretation.status, topicsAdded: topicsAdded.length, topicsRemoved: topicsRemoved.length,
    supplementsAdded: added.length, localRecordsChanged: recordsAdded.length + recordsRemoved.length + recordsChanged.length,
    timingScope: 'latest-display-to-submit', timingTrust: 'client-reported-unverified' };
  return { ...report, reviewEffort,
    interpretationSources: previous.interpretationSources ?? previous.partyStatements,
    operatorReview: { topics: input.topics, note: input.note.trim(), reviewedByRole: actor, reviewedAt: enteredAt,
      verification: 'topic-selection-only', modelInterpretationReused: true },
    changes: { parentPacketId: input.expectedPacketId,
      topicsAdded, topicsRemoved, supplementsAdded: added.map((s) => s.id), recordsAdded, recordsRemoved, recordsChanged,
      limitation: 'Record changes compare bounded local snapshots; removal can reflect the coverage window, not deletion. Supplemental material remains unverified.' },
  };
}

// Serialize every packet writer for a request. A stale review cannot replace a newer version.
// The lock protects packet lineage only; payment records can still change and are labelled separately.
export async function appendCasePacket(pool: Pool, requestId: string, actor: string, report: object, expectedPacketId: string | null = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`case-packet:${requestId}`]);
    const { rows: [latest] } = await client.query('SELECT id::text AS id FROM gateway_case_packets WHERE request_id=$1 ORDER BY gateway_case_packets.id DESC LIMIT 1', [requestId]);
    if ((latest?.id ?? null) !== expectedPacketId) throw new PaymentError(409, 'CASE_PACKET_VERSION_CONFLICT');
    const { rows: [saved] } = await client.query(`INSERT INTO gateway_case_packets(request_id,actor,report,parent_id)
      VALUES($1,$2,$3,$4) RETURNING id::text AS "packetId",created_at AS "createdAt",parent_id::text AS "parentPacketId"`,
    [requestId, actor, report, latest?.id ?? null]);
    await client.query('COMMIT'); return { ...report, ...saved };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
