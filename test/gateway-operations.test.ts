import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { buildApp, tokenDigest } from '../src/app.js';
import { transaction } from '../src/db.js';
import { gatewayOperationsMetrics, recordGatewayCase, recordWorkerHeartbeat, transitionGatewayCase } from '../src/gateway-cases.js';
import { migrate } from '../src/migrate.js';

async function port() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('operations lifecycle, upgrade, restart and cold-backup restore drill', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agops-'));
  const dbPort = await port();
  const password = randomUUID();
  const config = { host: '127.0.0.1', port: dbPort, database: 'postgres', user: 'postgres', password };
  const options = { port: dbPort, password, persistent: true, onLog: () => {}, onError: () => {},
    postgresFlags: ['-h', '127.0.0.1', '-k', directory] };
  const postgres = new EmbeddedPostgres({ ...options, databaseDir: join(directory, 'data') });
  let pool = new Pool(config);
  let started = false;
  let restored: EmbeddedPostgres | undefined;
  let restoredPool: Pool | undefined;
  t.after(async () => {
    await restoredPool?.end();
    await restored?.stop();
    await pool.end();
    if (started) await postgres.stop();
    await rm(directory, { force: true, recursive: true });
  });
  await postgres.initialise(); await postgres.start(); started = true;
  // Upgrade a populated 033 database using the actual migration runner.
  await pool.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY)');
  const files = (await readdir(new URL('../../db/', import.meta.url))).filter((file) => /^\d{3}_.*\.sql$/.test(file)).sort();
  for (const file of files.filter((file) => Number(file.slice(0, 3)) < 34)) {
    await pool.query(await readFile(new URL(`../../db/${file}`, import.meta.url), 'utf8'));
    await pool.query('INSERT INTO schema_migrations VALUES($1)', [Number(file.slice(0, 3))]);
  }
  const payer = `0x${'1'.repeat(40)}`;
  const requestId = randomUUID();
  let block = 1;
  async function scan(network = 'arcTestnet', wallet = payer) {
    const id = randomUUID();
    await pool.query(`INSERT INTO gateway_balance_scans(id,network,payer,from_block,to_block,status)
      VALUES($1,$2,$3,$4,$4,'discrepancy')`, [id,network,wallet,block++]);
    return id;
  }
  const first = await scan(); const second = await scan();
  for (const scanId of [first, second]) await pool.query(`
    INSERT INTO gateway_balance_discrepancies(id,scan_id,kind,detail) VALUES($1,$2,'unresolved-authorization',$3)`,
  [randomUUID(),scanId,JSON.stringify({ requestId, evidence: { status: 'pending' } })]);
  const financeToken = randomBytes(32).toString('base64url');
  const opsToken = randomBytes(32).toString('base64url');
  const oldApp = buildApp(pool, false, undefined, financeToken, false, opsToken);
  assert.equal((await oldApp.inject('/health/ready')).statusCode, 503);
  await oldApp.close();
  await migrate(pool);
  await migrate(pool);
  const app = buildApp(pool, false, undefined, financeToken, false, opsToken);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${opsToken}` };
  const { rows: [initial] } = await pool.query('SELECT * FROM gateway_reconciliation_cases');
  const id = initial.id;
  async function current() { return (await pool.query('SELECT * FROM gateway_reconciliation_cases WHERE id=$1', [id])).rows[0]; }
  async function transition(status: 'investigating' | 'resolved', version?: number) {
    const row = await current();
    return app.inject({ method: 'POST', url: `/finance/reconciliation-cases/${id}/transitions`, headers,
      payload: { status, expectedVersion: version ?? row.version, evidenceId: row.latest_discrepancy_id, note: 'Checked original scan evidence.' } });
  }
  async function observe(detail: unknown, network = 'arcTestnet') {
    const scanId = await scan(network);
    await transaction(pool, (client) => recordGatewayCase(client, scanId, 'unresolved-authorization', detail));
    return scanId;
  }
  await t.test('033 upgrade groups repeated sightings and readiness requires 034', async () => {
    assert.equal(initial.version, 2);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_reconciliation_cases')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_balance_discrepancies WHERE case_id=$1', [id])).rows[0].n, 2);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_case_events WHERE case_id=$1', [id])).rows[0].n, 2);
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
  });
  await t.test('operator lifecycle rejects stale, foreign and out-of-order evidence; closure moves no money', async () => {
    assert.equal((await transition('resolved')).statusCode, 409);
    const version = (await current()).version;
    const concurrent = await Promise.all([transition('investigating', version), transition('investigating', version)]);
    assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [200,409]);
    const row = await current();
    const foreign = await app.inject({ method:'POST', url:`/finance/reconciliation-cases/${id}/transitions`, headers,
      payload: { status:'resolved', expectedVersion:row.version, evidenceId:randomUUID(), note:'Wrong evidence' } });
    assert.equal(foreign.statusCode,409);
    assert.equal((await transition('resolved')).statusCode,200);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_payment_journal')).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_payment_refunds')).rows[0].n,0);
  });
  await t.test('identical evidence stays grouped; changed evidence reopens; network isolates cases', async () => {
    await observe({ requestId, evidence:{ status:'pending' } });
    assert.equal((await current()).status,'resolved');
    const oldVersion = (await current()).version;
    const scanId = await observe({ requestId, evidence:{ status:'conflict' } });
    assert.equal((await current()).status,'open');
    assert.equal((await transition('investigating',oldVersion)).statusCode,409);
    const newVersion = (await current()).version;
    await transaction(pool, (client) => recordGatewayCase(client,scanId,'unresolved-authorization',{ requestId,evidence:{ status:'conflict' } }));
    assert.equal((await current()).version,newVersion, 'same scan replay is idempotent');
    await observe({ requestId,evidence:{ status:'conflict' } },'arc');
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_reconciliation_cases')).rows[0].n,2);
  });
  await t.test('failed transaction leaves no half-persisted evidence or case version', async () => {
    const before = await current(); const scanId = await scan();
    await assert.rejects(transaction(pool,async (client) => {
      await recordGatewayCase(client,scanId,'unresolved-authorization',{ requestId,evidence:{ status:'unavailable' } });
      throw new Error('injected persistence failure');
    }),/injected/);
    assert.equal((await current()).version,before.version);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_balance_discrepancies WHERE scan_id=$1',[scanId])).rows[0].n,0);
  });
  await t.test('concurrent sightings share one case; batch keys persist across windows; balances retain window identity', async () => {
    const parallelRequest = randomUUID();
    const scans = await Promise.all([scan(),scan()]);
    await Promise.all(scans.map((scanId) => transaction(pool,(client) => recordGatewayCase(client,scanId,
      'unresolved-authorization',{ requestId:parallelRequest,evidence:{ status:'pending' } }))));
    const cases = await pool.query('SELECT * FROM gateway_reconciliation_cases WHERE subject=$1',[parallelRequest]);
    assert.equal(cases.rowCount,1);
    assert.equal(cases.rows[0].version,2);
    const batchHash=`0x${'a'.repeat(64)}`;
    for (const scanId of scans) await transaction(pool,async (client) => {
      await recordGatewayCase(client,scanId,'missing-batch',{ hash:batchHash });
      await recordGatewayCase(client,scanId,'balance',{ chainDifference:'1',journalDifference:'1' });
    });
    assert.equal((await pool.query("SELECT count(*)::int n FROM gateway_reconciliation_cases WHERE kind='missing-batch'")).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM gateway_reconciliation_cases WHERE kind='balance'")).rows[0].n,2);
  });
  await t.test('metrics expose staleness and worker errors; routes require operator credentials', async () => {
    await pool.query(`INSERT INTO gateway_balance_heads(network,payer,finalized_block,observed_at)
      VALUES('arcTestnet',$1,200,now()-interval '10 minutes')`,[payer]);
    await pool.query(`INSERT INTO gateway_balance_cursors(network,payer,next_block) VALUES('arcTestnet',$1,101)`,[payer]);
    await recordWorkerHeartbeat(pool,'gateway-reconciliation',false);
    await recordWorkerHeartbeat(pool,'gateway-reconciliation',false);
    await recordWorkerHeartbeat(pool,'gateway-reconciliation',true);
    const metrics = await gatewayOperationsMetrics(pool);
    assert.equal(metrics.wallets[0].lagBlocks,'100');
    assert.ok(metrics.wallets[0].headAgeSeconds>=600);
    assert.equal(metrics.workers[0].failure_count,2);
    assert.equal(metrics.workers[0].consecutive_failures,0);
    assert.equal(metrics.cases.open,6);
    for (const url of ['/finance/operations/metrics','/finance/reconciliation-cases',`/finance/reconciliation-cases/${id}`]) {
      assert.equal((await app.inject(url)).statusCode,401);
      assert.equal((await app.inject({ url,headers })).statusCode,200);
    }
    assert.equal((await app.inject({ url:'/finance/reconciliation-cases?status=invalid',headers })).statusCode,400);
    const agentToken=randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO agents(id,token_digest) VALUES($1,$2)',[randomUUID(),tokenDigest(agentToken)]);
    assert.equal((await app.inject({ url:'/finance/reconciliation-cases',headers:{ authorization:`Bearer ${agentToken}` } })).statusCode,401);
    assert.equal((await app.inject({ url:'/finance/operations/metrics',headers:{ authorization:`Bearer ${financeToken}` } })).statusCode,200);
    const detail = (await app.inject({ url:`/finance/reconciliation-cases/${id}`,headers })).json();
    assert.equal(detail.evidence.id,detail.latest_discrepancy_id);
    assert.equal(detail.events[0].version,detail.version);
  });

  await t.test('database restart and independent cold restore preserve budgets, journal, cases and cursors', async () => {
    const agent = randomUUID(); const task = randomUUID(); const purchase = randomUUID();
    await pool.query('INSERT INTO agents(id,token_digest) VALUES($1,$2)',[agent,tokenDigest(randomBytes(32).toString('base64url'))]);
    await pool.query(`INSERT INTO research_tasks(id,agent_id,active_until,budget,daily_limit,reserved,spent)
      VALUES($1,$2,now()+interval '1 day',10000,10000,1000,2000)`,[task,agent]);
    await pool.query(`INSERT INTO daily_spend(task_id,day,reserved,spent) VALUES($1,current_date,1000,2000)`,[task]);
    await pool.query(`INSERT INTO gateway_demo_purchases(request_id,endpoint,nonce,payer,recipient,amount_units,task_id,budget_day,budget_status,submitted_at)
      VALUES($1,'https://offline.example/trace',$2,$3,$3,2000,$4,current_date,'spent',now())`,[purchase,`0x${'2'.repeat(64)}`,payer,task]);
    await pool.query(`INSERT INTO gateway_payment_journal(request_id,transfer_id,batch_hash,amount) VALUES($1,'offline-transfer',$2,2000)`,[purchase,`0x${'3'.repeat(64)}`]);
    await pool.query(`INSERT INTO gateway_demo_purchases(request_id,endpoint,nonce,payer,recipient,amount_units,task_id,budget_day,budget_status,submitted_at)
      VALUES($1,'https://offline.example/trace',$2,$3,$3,1000,$4,current_date,'reserved',now())`,[randomUUID(),`0x${'4'.repeat(64)}`,payer,task]);
    const tables = ['schema_migrations','research_tasks','daily_spend','gateway_demo_purchases','gateway_payment_journal',
      'gateway_balance_cursors','gateway_balance_scans','gateway_balance_discrepancies','gateway_reconciliation_cases','gateway_case_events','gateway_worker_health','audit_history'];
    async function snapshot(db: Pool) {
      const result: Record<string, unknown> = {};
      for (const table of tables) result[table] = (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      return result;
    }
    const expected = await snapshot(pool);
    await app.close(); await pool.end(); await postgres.stop(); started=false;
    // Real filesystem backup, only after a clean shutdown. Never copy a live PGDATA.
    await cp(join(directory,'data'),join(directory,'restored'),{ recursive:true, force:false, errorOnExist:true });
    await postgres.start(); started=true; pool=new Pool(config);
    assert.deepEqual(await snapshot(pool),expected);
    const restoredPort = await port();
    restored = new EmbeddedPostgres({ ...options,port:restoredPort,databaseDir:join(directory,'restored') });
    await restored.start();
    restoredPool = new Pool({ ...config,port:restoredPort });
    assert.deepEqual(await snapshot(restoredPool),expected);
    await migrate(restoredPool);
    const row=(await restoredPool.query('SELECT * FROM gateway_reconciliation_cases WHERE id=$1',[id])).rows[0];
    await transitionGatewayCase(restoredPool,id,{ expectedVersion:row.version,status:'investigating',
      evidenceId:row.latest_discrepancy_id,note:'Verified restored evidence.' },'operations');
    assert.equal((await current()).status,'open','restored writes do not affect source');
  });
});
