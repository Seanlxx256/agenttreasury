import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeReviewEffort, type ReviewEffort } from '../src/gateway-case-packet-effort.js';

const base: ReviewEffort = { version: 1, origin: 'interactive-declared', elapsedMs: 1000, phase: 'first-review',
  model: null, modelStatus: 'disabled', topicsAdded: 1, topicsRemoved: 2, supplementsAdded: 1, localRecordsChanged: 0,
  timingScope: 'latest-display-to-submit', timingTrust: 'client-reported-unverified' };
const row = (id: number, patch: Partial<ReviewEffort> = {}) => ({ packetId: String(id), effort: { ...base, ...patch } });

test('review telemetry separates simulations, model failures and repeated follow-ups', () => {
  const summary = summarizeReviewEffort([row(8), row(7, { elapsedMs: 3000 }), row(6, { origin: 'simulation-declared', elapsedMs: 1 }),
    row(5, { phase: 'follow-up', elapsedMs: 500 }), row(4, { model: 'fixture', modelStatus: 'rejected' }),
    row(3, { model: 'fixture', modelStatus: 'ready' }), row(2, { model: 'other', modelStatus: 'ready' }),
    { packetId: '1', effort: null }], false);
  assert.equal(summary.groups.length, 6); assert.equal(summary.unmeasuredReviews, 1);
  assert.equal(summary.groups[0]!.savedReviews, 2); assert.equal(summary.groups[0]!.medianElapsedMs, 2000);
  assert.equal(summary.groups[0]!.topicEdits, 6); assert.equal(summary.groups[0]!.supplementsAdded, 2);
  assert.match(summary.conclusion, /No causal time savings/);
  assert.ok(!JSON.stringify(summary).includes('accuracyRate'));
});

test('missing, over-limit and unclassified timing is never imputed as zero', () => {
  const result = summarizeReviewEffort([row(5, { elapsedMs: null }), row(4, { elapsedMs: 3600001 }),
    row(3, { elapsedMs: 0 }), row(2, { elapsedMs: 500, origin: 'unclassified' }), row(1, { elapsedMs: -1 })], true);
  assert.equal(result.groups[0]!.timedReviews, 1); assert.equal(result.groups[0]!.untimedReviews, 3);
  assert.equal(result.groups[0]!.medianElapsedMs, 0);
  assert.equal(result.groups[1]!.medianElapsedMs, null);
  assert.equal(result.window.truncated, true); assert.equal(result.window.newestPacketId, '5');
  assert.equal(summarizeReviewEffort([], false).window.oldestPacketId, null);
});
