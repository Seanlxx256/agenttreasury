import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { seedGateway } from '../src/seed.js';
import { reviseCasePacket } from '../src/gateway-case-packet-revision.js';
import { assembleCasePacket, collectPacketSources, interpretPacketClaims, statementSources, validPacketIssues } from '../src/gateway-case-packet.js';

const statements = { customerStatement: 'I was charged twice and cannot open the purchased data.', merchantStatement: 'We already refunded the order.' };

test('case packet claim interpretation binds quotes, treats statements as unverified and rejects action injection', async () => {
  const sources = statementSources(statements);
  const good = { issues: [{ topic: 'refund-claimed', sourceId: 'statement-merchant', quote: statements.merchantStatement }] };
  const result = await interpretPacketClaims(sources, 'fixture', async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const payload = JSON.parse(String(init?.body)); assert.ok(!payload.messages[1].content.includes('recordedFacts'));
    assert.deepEqual(JSON.parse(payload.messages[1].content).claims, sources.map(({ id, data }) => ({ id, text: data.text })));
    return Response.json({ message: { content: JSON.stringify(good) } });
  });
  assert.equal(result.status, 'ready'); assert.equal(result.verification, 'unverified');
  for (const invalid of [{ ...good, action: 'refund' }, { issues: [{ ...good.issues[0], quote: 'invented' }] },
    { issues: [{ ...good.issues[0], sourceId: 'refund' }] }, { issues: [{ ...good.issues[0], topic: 'execute-refund' }] },
    { issues: [good.issues[0], good.issues[0]] }]) assert.equal(validPacketIssues(invalid, sources), false);
  // Exact quotation proves source membership only, not interpretation correctness.
  assert.equal(validPacketIssues({ issues: [{ ...good.issues[0], topic: 'duplicate-charge' }] }, sources), true);
  const failed = await interpretPacketClaims(sources, 'fixture', async () => { throw new Error('SECRET'); });
  assert.equal(failed.status, 'unavailable'); assert.ok(!JSON.stringify(failed).includes('SECRET'));
  const rejected = await interpretPacketClaims(sources, 'fixture', async () => Response.json({ message: { content: '{"issues":[],"approve":true}' } }));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, '/: invalid-issue-object'); assert.ok(rejected.diagnostics.rawOutput?.includes('approve'));
  const quoteFailure = await interpretPacketClaims(sources, 'fixture', async () => Response.json({ message: {
    content: JSON.stringify({ issues: [{ ...good.issues[0], quote: 'fabricated refund confirmation' }] }) } }));
  assert.equal(quoteFailure.reason, '/issues/0/quote: quote-not-in-source');
  const oversized = await interpretPacketClaims(sources, 'fixture', async () => new Response('x'.repeat(65537)));
  assert.equal(oversized.reason, 'response-too-large');
});

test('case packets bind real database records without financial mutation and preserve advisory history', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'casepacket-'));
  const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const config = { host: '127.0.0.1', port, password: randomUUID(), user: 'postgres', database: 'postgres' };
  const postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), port, password: config.password, persistent: true,
    postgresFlags: ['-h', '127.0.0.1', '-k', directory], onLog: () => {}, onError: () => {} });
  const pool = new Pool(config), finance = randomBytes(32).toString('hex'), operations = randomBytes(32).toString('hex');
  const previousModel = process.env.GATEWAY_CASE_PACKET_MODEL; delete process.env.GATEWAY_CASE_PACKET_MODEL;
  const app = buildApp(pool, false, undefined, finance, false, operations);
  let started = false, reader: Pool | undefined;
  t.after(async () => {
    if (previousModel === undefined) delete process.env.GATEWAY_CASE_PACKET_MODEL; else process.env.GATEWAY_CASE_PACKET_MODEL = previousModel;
    await app.close(); await reader?.end(); await pool.end(); if (started) await postgres.stop(); await rm(directory, { recursive: true, force: true });
  });
  await postgres.initialise(); await postgres.start(); started = true; await migrate(pool); await migrate(pool);
  const payer = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`;
  const task = await seedGateway(pool, { origin: 'https://merchant.example', payer, recipient });
  async function make() {
    const id = randomUUID(), nonce = `0x${randomBytes(32).toString('hex')}`;
    await pool.query(`INSERT INTO gateway_demo_purchases(request_id,endpoint,nonce,payer,recipient,amount_units,task_id,budget_day,budget_status,
      retrieval_token,delivery,commitment_satisfied,signing_authorization) VALUES($1,'https://merchant.example/trace',$2,$3,$4,1000,$5,current_date,'spent',
      'PRIVATE_RETRIEVAL','{"secret":"PRIVATE_DELIVERY"}',false,'{"signature":"PRIVATE_SIGNATURE"}')`, [id, nonce, payer, recipient, task.taskId]);
    await pool.query(`INSERT INTO gateway_payment_journal(request_id,transfer_id,batch_hash,amount) VALUES($1,$2,$3,1000)`,
      [id, randomUUID(), `0x${'3'.repeat(64)}`]);
    return id;
  }
  const id = await make(), other = await make(), url = `/finance/gateway-purchases/${id}/case-packet`, headers = { authorization: `Bearer ${operations}` };
  await pool.query(`INSERT INTO gateway_delivery_disputes(request_id,reason,evidence,raised_by) VALUES($1,'Cannot open delivery','{"secret":"PRIVATE_DISPUTE"}',$2)`, [id, task.agentId]);
  await pool.query(`INSERT INTO gateway_refund_requests(request_id,reason,requested_by,status,decided_by,decided_at)
    VALUES($1,'Request refund',$2,'APPROVED','finance',now())`, [id, task.agentId]);
  await pool.query(`INSERT INTO gateway_payment_observations(request_id,source,evidence) VALUES($1,'worker','{"status":"charged"}')`, [id]);
  await pool.query(`INSERT INTO gateway_payment_observations(request_id,source,evidence) VALUES($1,'worker','{"status":"conflict","reason":"OTHER_ORDER_SECRET"}')`, [other]);
  const tables = ['gateway_demo_purchases', 'gateway_payment_journal', 'gateway_payment_journal_lines', 'research_tasks', 'daily_spend',
    'gateway_refund_requests', 'gateway_refund_authorizations', 'gateway_payment_refunds', 'gateway_delivery_disputes', 'gateway_payment_observations', 'audit_history'];
  async function state() {
    const rows: Record<string, unknown> = {};
    for (const table of tables) rows[table] = (await pool.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return rows;
  }
  await t.test('SELECT-only collector omits secrets and other orders; no party assertion becomes a financial fact', async () => {
    const password = randomBytes(16).toString('hex'); await pool.query(`CREATE ROLE packet_reader LOGIN PASSWORD '${password}'`);
    await pool.query(`GRANT SELECT ON gateway_demo_purchases,gateway_demo_deliveries,gateway_payment_journal,gateway_refund_requests,
      gateway_refund_authorizations,gateway_payment_refunds,gateway_delivery_disputes,gateway_payment_observations,audit_history TO packet_reader`);
    reader = new Pool({ ...config, user: 'packet_reader', password });
    const before = await state(), snapshot = await collectPacketSources(reader, id);
    const packet = assembleCasePacket(snapshot, statements, await interpretPacketClaims([]));
    assert.deepEqual(await state(), before); assert.ok(!JSON.stringify(packet).includes('PRIVATE_'));
    assert.ok(!JSON.stringify(packet).includes('OTHER_ORDER_SECRET')); assert.ok(!JSON.stringify(packet).includes(task.token));
    assert.equal(packet.financialAuthority, false); assert.equal(packet.merchantInquiryDraft.status, 'draft-not-sent');
    assert.match(packet.recordedFacts[3]!.text, /No verified refund posting/); assert.match(packet.recordedFacts[3]!.text, /APPROVED/);
    assert.equal(packet.evidenceGaps.length, 3);
    const updated = structuredClone(snapshot);
    updated.sources.find((s) => s.id === 'dispute-claim')!.data.text = 'Access now works.';
    const revision = reviseCasePacket(packet, updated, { expectedPacketId: '1', topics: [], note: 'Corrected claim.', supplements: [] }, 'operations');
    assert.equal(revision.sources.find((s) => s.id === 'dispute-claim')!.data.text, 'Access now works.');
    assert.equal(revision.interpretationSources.find((s) => s.id === 'dispute-claim')!.data.text, packet.partyStatements.find((s) => s.id === 'dispute-claim')!.data.text);
    assert.deepEqual(revision.modelInterpretation, packet.modelInterpretation);

    assert.ok(!JSON.stringify(packet.recordedFacts).includes('We already refunded'));
    for (const item of [...packet.recordedFacts, ...packet.evidenceGaps]) for (const citation of item.citations) assert.ok(packet.sources.some((s) => s.id === citation));
  });
  await t.test('API requires an operator, rejects target/model/action injection and only appends a packet', async () => {
    assert.equal((await app.inject({ method: 'POST', url, payload: statements })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, payload: statements, headers: { authorization: `Bearer ${task.token}` } })).statusCode, 401);
    for (const extra of [{ requestId: other }, { model: 'arbitrary' }, { refund: true }, { sourceIds: ['other'] }]) {
      assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...statements, ...extra } })).statusCode, 400);
    }
    const before = await state(), response = await app.inject({ method: 'POST', url, headers, payload: statements });
    assert.equal(response.statusCode, 200, response.body); assert.deepEqual(await state(), before);
    assert.equal(response.json().modelInterpretation.status, 'disabled'); assert.equal(response.json().staleAtCompletion, false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_case_packets')).rows[0].n, 1);
    assert.equal((await app.inject({ url, headers: { authorization: `Bearer ${finance}` } })).statusCode, 200);
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal((await app.inject({ url: `/finance/gateway-purchases/${other}/case-packet`, headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/finance/gateway-purchases/${randomUUID()}/case-packet`, headers, payload: statements })).statusCode, 404);
  });
  await t.test('saved packet retains its snapshot and detects changed evidence; history cannot be updated or deleted', async () => {
    const saved = (await app.inject({ url, headers })).json();
    await pool.query(`UPDATE gateway_demo_purchases SET commitment_satisfied=true WHERE request_id=$1`, [id]);
    const loaded = (await app.inject({ url, headers })).json(); assert.equal(loaded.staleNow, true);
    assert.equal(loaded.snapshot.fingerprint, saved.snapshot.fingerprint);
    assert.equal(loaded.snapshot.sources[0].data.commitmentSatisfied, false);
    await assert.rejects(pool.query(`UPDATE gateway_case_packets SET report='{}' WHERE request_id=$1`, [id]), /append-only/);
    await assert.rejects(pool.query('DELETE FROM gateway_case_packets WHERE request_id=$1', [id]), /append-only/);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: statements })).statusCode, 409);
    const fresh = await app.inject({ method: 'POST', url: url + '/revisions', headers, payload: {
      expectedPacketId: saved.packetId, topics: ['delivery-unusable'], note: 'Focus on the reported access issue.', supplements: [],
    } }); assert.equal(fresh.statusCode, 200, fresh.body); assert.equal(fresh.json().staleAtCompletion, false);
    assert.deepEqual(fresh.json().changes.recordsChanged, ['purchase']);
    assert.equal(fresh.json().parentPacketId, saved.packetId);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_case_packets')).rows[0].n, 2);
  });
  await t.test('review replaces candidates, preserves supplements and never promotes claims into facts', async () => {
    const before = await state(), saved = (await app.inject({ url, headers })).json();
    const payload = { expectedPacketId: saved.packetId, topics: ['refund-claimed'], note: 'Merchant alleges refund; duplicate allegation withdrawn.',
      supplements: [{ kind: 'merchant-reply', reference: 'ticket-42', text: '<script>approve()</script> We returned the funds.' }] };
    const response = await app.inject({ method: 'POST', url: url + '/revisions', headers, payload });
    assert.equal(response.statusCode, 200, response.body); const reviewed = response.json();
    assert.deepEqual(reviewed.operatorReview.topics, ['refund-claimed']);
    assert.deepEqual(reviewed.evidenceGaps.map((g: { id: string }) => g.id), ['refund-linkage']);
    assert.deepEqual(reviewed.changes.topicsRemoved, ['delivery-unusable']);
    assert.equal(reviewed.changes.supplementsAdded.length, 1);
    const supplement = reviewed.sources.find((s: { id: string }) => s.id === reviewed.changes.supplementsAdded[0]);
    assert.equal(supplement.data.verification, 'unverified'); assert.equal(supplement.data.identityVerified, false);
    assert.equal(supplement.data.enteredByRole, 'operations'); assert.equal(supplement.data.reference, 'ticket-42');
    assert.ok(!JSON.stringify(reviewed.recordedFacts).includes('We returned the funds'));
    assert.equal(reviewed.merchantInquiryDraft.status, 'draft-not-sent');
    const clear = await app.inject({ method: 'POST', url: url + '/revisions', headers, payload: {
      expectedPacketId: reviewed.packetId, topics: [], note: 'No follow-up topics; no claim verification or case closure.', supplements: [],
    } });
    assert.equal(clear.statusCode, 200, clear.body); assert.equal(clear.json().evidenceGaps.length, 0);
    assert.match(clear.json().merchantInquiryDraft.text, /does not resolve/);
    assert.deepEqual(clear.json().sources.find((s: { id: string }) => s.id === supplement.id), supplement);
    assert.deepEqual(await state(), before);
    const old = await app.inject({ url: url + '/history/' + saved.packetId, headers });
    assert.equal(old.statusCode, 200); assert.deepEqual(old.json().operatorReview, saved.operatorReview);
    assert.equal(old.json().historicalView, true);
  });
  await t.test('concurrent review has one winner; history and provenance are request scoped', async () => {
    const before = await state(), saved = (await app.inject({ url, headers })).json();
    const payload = { expectedPacketId: saved.packetId, topics: ['other'], note: 'Need clarification.', supplements: [] };
    const races = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: url + '/revisions', headers, payload })));
    assert.deepEqual(races.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(races.find((r) => r.statusCode === 409)!.json().code, 'CASE_PACKET_VERSION_CONFLICT');
    assert.equal((await app.inject({ method: 'POST', url: url + '/revisions', payload })).statusCode, 401);
    assert.equal((await app.inject({ url: url + '/history', headers: { authorization: `Bearer ${task.token}` } })).statusCode, 401);
    assert.equal((await app.inject({ url: url + '/history/' + saved.packetId })).statusCode, 401);
    for (const change of [{ verified: true }, { note: ' ' }, { topics: ['other', 'other'] }, { topics: ['refund-now'] },
      { supplements: [{ kind: 'merchant-reply', reference: 'ticket', text: 'paid', verification: 'verified' }] },
      { supplements: [{ kind: 'merchant-reply', reference: ' ', text: 'paid' }] }, { expectedPacketId: '9999999999999999999' }]) {
      const response = await app.inject({ method: 'POST', url: url + '/revisions', headers, payload: { ...payload, ...change } });
      assert.equal(response.statusCode, 400, response.body);
    }
    const otherUrl = `/finance/gateway-purchases/${other}/case-packet`;
    assert.equal((await app.inject({ method: 'POST', url: otherUrl + '/revisions', headers, payload })).statusCode, 404);
    assert.equal((await app.inject({ url: otherUrl + '/history/' + saved.packetId, headers })).statusCode, 404);
    await assert.rejects(pool.query(`INSERT INTO gateway_case_packets(request_id,actor,report,parent_id) VALUES($1,'operations','{}',$2)`, [other, races.find((r) => r.statusCode === 200)!.json().packetId]), /case_packet_parent_scope/);
    const history = (await app.inject({ url: url + '/history', headers })).json();
    assert.ok(history.packets.every((p: { packetId: string }, i: number) => i === 0 || BigInt(p.packetId) < BigInt(history.packets[i - 1].packetId)));
    assert.ok(!JSON.stringify(history).includes('approve()')); // Index exposes metadata, not claim contents.
    assert.deepEqual(await state(), before);
  });
  await t.test('supplement growth is bounded and history pagination has no skipped versions', async () => {
    let saved = (await app.inject({ url, headers })).json();
    // One supplement was already saved by the previous review.
    for (let i = 0; i < 29; i++) {
      const response = await app.inject({ method: 'POST', url: url + '/revisions', headers, payload: {
        expectedPacketId: saved.packetId, topics: [], note: 'Append follow-up material.',
        supplements: [{ kind: 'operator-observation', reference: `note-${i}`, text: 'Unverified additional context.' }],
      } });
      assert.equal(response.statusCode, 200, response.body); saved = response.json();
    }
    const full = await app.inject({ method: 'POST', url: url + '/revisions', headers, payload: {
      expectedPacketId: saved.packetId, topics: [], note: 'Another material.',
      supplements: [{ kind: 'merchant-reply', reference: 'overflow', text: 'Extra.' }],
    } });
    assert.equal(full.statusCode, 409); assert.equal(full.json().code, 'CASE_PACKET_SUPPLEMENT_LIMIT');
    const page1 = (await app.inject({ url: url + '/history', headers })).json(); assert.equal(page1.packets.length, 20);
    const page2 = (await app.inject({ url: url + '/history?before=' + page1.nextBefore, headers })).json();
    assert.equal(page2.nextBefore, null);
    const ids = [...page1.packets, ...page2.packets].map((p: { packetId: string }) => p.packetId);
    const persisted = (await pool.query('SELECT id::text id FROM gateway_case_packets WHERE request_id=$1 ORDER BY gateway_case_packets.id DESC', [id])).rows.map((r) => r.id);
    assert.deepEqual(ids, persisted);
    // Initial creation also serializes; an existing packet cannot be reset to unreviewed model output.
    const results = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/finance/gateway-purchases/${other}/case-packet`, headers, payload: statements })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  });
  await t.test('context-held packets require explicit topic selection while preserving every financial record', async () => {
    const contextId = await make(), contextUrl = `/finance/gateway-purchases/${contextId}/case-packet`;
    const before = await state();
    const created = await app.inject({ method: 'POST', url: contextUrl, headers, payload: {
      customerStatement: 'I was not charged twice on invoice X-90. The data is unusable.', merchantStatement: '',
    } });
    assert.equal(created.statusCode, 200, created.body); const packet = created.json();
    assert.deepEqual(packet.selectedTopics, []); assert.equal(packet.merchantInquiryDraft.reviewRequired, true);
    assert.equal(packet.candidateReview.needsOperatorReview, true);
    assert.ok(packet.ruleIssues.issues.some((i: { topic: string }) => i.topic === 'delivery-unusable'));
    const reviewed = await app.inject({ method: 'POST', url: contextUrl + '/revisions', headers, payload: {
      expectedPacketId: packet.packetId, topics: ['delivery-unusable'], supplements: [], note: 'The access complaint remains current; duplicate claim is denied.',
    } });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    assert.equal(reviewed.json().merchantInquiryDraft.reviewRequired, false); assert.equal(reviewed.json().financialAuthority, false);
    assert.equal(reviewed.json().reviewEffort.topicsAdded, 1); assert.equal(reviewed.json().reviewEffort.topicsRemoved, 0);
    assert.deepEqual(reviewed.json().changes.topicsAdded, ['delivery-unusable']);
    assert.equal(reviewed.json().candidateReview.needsOperatorReview, true);
    assert.deepEqual(await state(), before);
    const original = (await app.inject({ url: contextUrl + '/history/' + packet.packetId, headers })).json();
    assert.equal(original.merchantInquiryDraft.reviewRequired, true); assert.deepEqual(original.selectedTopics, []);
  });
  await t.test('effort is derived from saved revisions, scoped, authenticated and separate from financial state', async () => {
    const metricsId = await make(), metricUrl = `/finance/gateway-purchases/${metricsId}/case-packet`;
    const before = await state();
    const root = (await app.inject({ method: 'POST', url: metricUrl, headers, payload: statements })).json();
    const payload = { expectedPacketId: root.packetId, topics: ['delivery-unusable'], note: 'Synthetic review fixture.', supplements: [],
      timing: { origin: 'simulation-declared', elapsedMs: 75 } };
    for (const timing of [{ origin: 'human-verified', elapsedMs: 10 }, { origin: 'simulation-declared', elapsedMs: -1 },
      { origin: 'simulation-declared', elapsedMs: 3600001 }, { origin: 'simulation-declared', elapsedMs: 1.5 },
      { origin: 'simulation-declared', elapsedMs: 1, topicsRemoved: 0 }, { origin: 'simulation-declared' }]) {
      assert.equal((await app.inject({ method: 'POST', url: metricUrl + '/revisions', headers, payload: { ...payload, timing } })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: 'POST', url: metricUrl + '/revisions', headers,
      payload: { ...payload, reviewEffort: { modelStatus: 'ready', topicsAdded: 0 } } })).statusCode, 400);
    const response = await app.inject({ method: 'POST', url: metricUrl + '/revisions', headers, payload });
    assert.equal(response.statusCode, 200, response.body);
    const saved = response.json(); assert.equal(saved.reviewEffort.phase, 'first-review');
    assert.equal(saved.reviewEffort.topicsRemoved, 2); assert.equal(saved.reviewEffort.topicsAdded, 0);
    assert.equal(saved.reviewEffort.modelStatus, 'disabled'); assert.equal(saved.reviewEffort.elapsedMs, 75);
    assert.equal((await app.inject({ method: 'POST', url: metricUrl + '/revisions', headers, payload })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: metricUrl + '/revisions', headers, payload: { ...payload,
      expectedPacketId: saved.packetId, timing: { origin: 'interactive-declared', elapsedMs: null } } })).statusCode, 200);
    const summary = await app.inject({ url: metricUrl + '/effort', headers }); assert.equal(summary.statusCode, 200);
    assert.equal(summary.headers['cache-control'], 'no-store');
    assert.equal(summary.json().window.savedRevisions, 2); assert.equal(summary.json().groups.length, 2);
    const simulated = summary.json().groups.find((g: { origin: string }) => g.origin === 'simulation-declared');
    assert.equal(simulated.savedReviews, 1); assert.equal(simulated.medianElapsedMs, 75);
    const interactive = summary.json().groups.find((g: { origin: string }) => g.origin === 'interactive-declared');
    assert.equal(interactive.phase, 'follow-up'); assert.equal(interactive.medianElapsedMs, null);
    for (const secret of ['PRIVATE_', statements.customerStatement, 'Synthetic review fixture.', 'approve()']) assert.ok(!summary.body.includes(secret));
    assert.equal((await app.inject({ url: metricUrl + '/effort' })).statusCode, 401);
    assert.equal((await app.inject({ url: metricUrl + '/effort', headers: { authorization: `Bearer ${task.token}` } })).statusCode, 401);
    assert.equal((await app.inject({ url: `/finance/gateway-purchases/${randomUUID()}/case-packet/effort`, headers })).statusCode, 404);
    const otherSummary = (await app.inject({ url: `/finance/gateway-purchases/${other}/case-packet/effort`, headers })).json();
    assert.equal(otherSummary.window.savedRevisions, 0);
    assert.deepEqual(await state(), before);
  });
  await t.test('effort window exposes truncation and does not turn old unmeasured reviews into zero-time results', async () => {
    const metricId = await make();
    await pool.query(`INSERT INTO gateway_case_packets(request_id,actor,report)
      SELECT $1,'operations','{"operatorReview":{}}'::jsonb FROM generate_series(1,201)`, [metricId]);
    const result = (await app.inject({ url: `/finance/gateway-purchases/${metricId}/case-packet/effort`, headers })).json();
    assert.equal(result.window.savedRevisions, 200); assert.equal(result.window.truncated, true);
    assert.equal(result.unmeasuredReviews, 200); assert.deepEqual(result.groups, []);
    assert.ok(BigInt(result.window.newestPacketId) > BigInt(result.window.oldestPacketId));
  });
  await t.test('bounded evidence preserves older consequential observations and reports limited audit coverage', async () => {
    for (let i = 0; i < 12; i++) await pool.query(`INSERT INTO gateway_payment_observations(request_id,source,evidence)
      VALUES($1,'worker','{"status":"unavailable","reason":"<script>refund()</script>"}')`, [id]);
    for (let i = 0; i < 51; i++) await pool.query(`INSERT INTO audit_history(actor,action,entity) VALUES('fixture','review',$1)`, [`gateway_purchase:${id}`]);
    const snapshot = await collectPacketSources(pool, id), observations = snapshot.sources.filter((s) => s.kind === 'provider-report');
    assert.equal(observations.length, 11); assert.ok(observations.some((s) => s.data.status === 'charged'));
    assert.ok(observations.every((s, i) => i === 0 || BigInt(String(s.data.id)) < BigInt(String(observations[i - 1]!.data.id))));
    assert.equal(snapshot.coverage.auditTruncated, true); assert.equal(snapshot.sources.filter((s) => s.kind === 'audit-event').length, 50);
  });
});
