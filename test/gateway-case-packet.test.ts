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
    const fresh = await app.inject({ method: 'POST', url, headers, payload: statements }); assert.equal(fresh.json().staleAtCompletion, false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_case_packets')).rows[0].n, 2);
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
