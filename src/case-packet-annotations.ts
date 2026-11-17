import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { exportPacketAnnotationForm, packetEvaluationCases, type PacketEvaluationCase } from './case-packet-evaluation-cases.js';
import { packetIssueError, statementSources, type PacketIssue } from './gateway-case-packet.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const sorted = (values: string[]) => [...new Set(values)].sort();
const topicKeys = (issues: PacketIssue[]) => sorted(issues.map((i) => JSON.stringify([i.sourceId, i.topic])));
const quoteKeys = (issues: PacketIssue[]) => sorted(issues.map((i) => JSON.stringify([i.sourceId, i.topic, i.quote])));
const gapForTopic = { 'duplicate-charge': 'second-charge', 'delivery-unusable': 'delivery-reproduction',
  'refund-claimed': 'refund-linkage', other: 'clarify-claim' };
const fail = (path: string, reason: string): never => { throw new Error(`Invalid annotation ${path}: ${reason}`); };
function object(value: unknown, keys: string[], path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) fail(path, 'unexpected or missing fields');
}
function nonblank(value: unknown, max: number, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(path, 'nonblank bounded text required');
}
function diff(a: PacketEvaluationCase['annotation'], b: PacketEvaluationCase['annotation']) {
  const first = topicKeys(a.issues), second = topicKeys(b.issues);
  return { topicPairsAdded: second.filter((v) => !first.includes(v)), topicPairsRemoved: first.filter((v) => !second.includes(v)),
    materialCategoriesAgree: isDeepStrictEqual(sorted(a.requiredGapIds), sorted(b.requiredGapIds)),
    supportingQuotesAgree: isDeepStrictEqual(quoteKeys(a.issues), quoteKeys(b.issues)) };
}

export function validatePacketAnnotations(value: unknown, now = Date.now()) {
  const template = exportPacketAnnotationForm(), original = packetEvaluationCases();
  object(value, Object.keys(template), '/');
  for (const key of ['schemaVersion', 'datasetId', 'inputDigest', 'purpose', 'instructions'] as const) {
    if (value[key] !== template[key]) fail('/' + key, 'form version or input binding changed; export a current form');
  }
  if (!Array.isArray(value.cases) || value.cases.length !== original.length) fail('/cases', 'complete case set required');
  const byId = new Map<string, Record<string, unknown>>();
  for (const [index, row] of (value.cases as unknown[]).entries()) {
    object(row, ['id', 'input', 'snapshot', 'annotation'], `/cases/${index}`);
    if (typeof row.id !== 'string' || !original.some((c) => c.id === row.id) || byId.has(row.id)) fail(`/cases/${index}/id`, 'unknown or duplicate case');
    byId.set(row.id as string, row);
  }
  const cases: PacketEvaluationCase[] = []; const normalized: unknown[] = [];
  let reviewer = '', relationship = '';
  for (const [index, expected] of template.cases.entries()) {
    const row = byId.get(expected.id)!; const path = `/cases/${expected.id}`;
    if (!isDeepStrictEqual(row.input, expected.input) || !isDeepStrictEqual(row.snapshot, expected.snapshot)) fail(path, 'input or snapshot changed');
    const a = row.annotation;
    object(a, Object.keys(expected.annotation), path + '/annotation');
    if (a.status !== 'reviewed') fail(path + '/status', 'explicit reviewed status required, even for empty negative labels');
    if (!['external-declared', 'author-declared', 'simulation'].includes(String(a.relationship))) fail(path + '/relationship', 'declare provenance');
    if (typeof a.reviewer !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(a.reviewer)) fail(path + '/reviewer', 'use a lowercase pseudonym of 2 to 64 characters');
    if (reviewer && (reviewer !== a.reviewer || relationship !== a.relationship)) fail(path, 'one reviewer and relationship per form required');
    reviewer = a.reviewer as string; relationship = a.relationship as string;
    nonblank(a.rationale, 2000, path + '/rationale');
    if (typeof a.reviewedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(a.reviewedAt)
      || !Number.isFinite(Date.parse(a.reviewedAt)) || new Date(a.reviewedAt).toISOString() !== a.reviewedAt
      || Date.parse(a.reviewedAt) > now) fail(path + '/reviewedAt', 'valid nonfuture ISO UTC timestamp required');
    const issueError = packetIssueError({ issues: a.issues }, statementSources(expected.input));
    if (issueError) fail(path + '/issues', issueError);
    const issues = (a.issues as PacketIssue[]).map((i) => ({ topic: i.topic, sourceId: i.sourceId, quote: i.quote }))
      .sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : JSON.stringify(x) > JSON.stringify(y) ? 1 : 0);
    if (!Array.isArray(a.requiredGapIds) || a.requiredGapIds.length > 4 || a.requiredGapIds.some((g) => typeof g !== 'string')
      || new Set(a.requiredGapIds).size !== a.requiredGapIds.length
      || !isDeepStrictEqual(sorted(a.requiredGapIds as string[]), sorted(issues.map((i) => gapForTopic[i.topic]))))
      fail(path + '/requiredGapIds', 'unique material categories must correspond to annotated topics');
    const annotation = { issues, requiredGapIds: sorted(a.requiredGapIds as string[]), rationale: a.rationale.trim() };
    cases.push({ ...original[index]!, annotation });
    normalized.push({ id: expected.id, annotation: { ...annotation, reviewer, relationship, status: 'reviewed', reviewedAt: a.reviewedAt } });
  }
  const disagreementsWithAuthor = cases.flatMap((sample, index) => {
    const differences = diff(original[index]!.annotation, sample.annotation);
    return differences.topicPairsAdded.length || differences.topicPairsRemoved.length || !differences.materialCategoriesAgree || !differences.supportingQuotesAgree
      ? [{ id: sample.id, ...differences }] : [];
  });
  return { form: value, cases, datasetId: template.datasetId, inputDigest: template.inputDigest,
    annotationDigest: sha(JSON.stringify({ inputDigest: template.inputDigest, reviewer, relationship, normalized })),
    reviewer: { id: reviewer, relationship, identityVerified: false }, independentReview: false, promotionEligible: false,
    validation: 'schema-input-and-quote-provenance-only', disagreementsWithAuthor,
    limitation: 'A valid form does not authenticate its reviewer, prove independence or semantic truth. Author labels are a comparison, not a veto. Review disagreements explicitly; do not silently adjudicate.' };
}
export type ValidatedPacketAnnotations = ReturnType<typeof validatePacketAnnotations>;

export async function loadPacketAnnotations(path: string) {
  const file = await open(path, 'r');
  try {
    const limit = 1024 * 1024, buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break; length += bytesRead;
    }
    if (length > limit) throw new Error('Annotation input exceeds 1 MiB');
    const raw = buffer.subarray(0, length).toString('utf8');
    return { ...validatePacketAnnotations(JSON.parse(raw)), sourceFileDigest: sha(raw) };
  } finally { await file.close(); }
}

export function comparePacketAnnotations(first: ValidatedPacketAnnotations, second: ValidatedPacketAnnotations) {
  if (first.inputDigest !== second.inputDigest) throw new Error('Cannot compare different input corpora');
  if (first.reviewer.id === second.reviewer.id) throw new Error('Comparison requires distinct declared reviewer IDs');
  const differences = first.cases.map((sample, i) => ({ id: sample.id, ...diff(sample.annotation, second.cases[i]!.annotation) }));
  return { datasetId: first.datasetId, inputDigest: first.inputDigest,
    reviewers: [first.reviewer, second.reviewer], annotationDigests: [first.annotationDigest, second.annotationDigest],
    cases: differences.length, topicPairAgreementCases: differences.filter((d) => !d.topicPairsAdded.length && !d.topicPairsRemoved.length).length,
    materialAgreementCases: differences.filter((d) => d.materialCategoriesAgree).length,
    quoteAgreementCases: differences.filter((d) => d.supportingQuotesAgree).length,
    disagreements: differences.filter((d) => d.topicPairsAdded.length || d.topicPairsRemoved.length || !d.materialCategoriesAgree || !d.supportingQuotesAgree),
    adjudicated: false, independentReview: false,
    limitation: 'Declared IDs do not prove distinct people or independent review. Differences remain unresolved; no majority vote or automatic ground truth is created.' };
}
