import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { reserveAmount } from '../src/budget.js';
import { transaction } from '../src/db.js';
import { releaseUnsubmittedGatewayPurchase } from '../src/gateway-budget.js';
import { gatewaySignerClient } from '../src/gateway-signer-client.js';
import { buildGatewaySigner } from '../src/gateway-signer.js';
import { checkGatewayPayment } from '../src/gateway-payment-evidence.js';
import { purchaseGatewayTrace, type SigningRequest } from '../src/gateway-purchase.js';
import { processGatewayReconciliation } from '../src/gateway-reconciliation-worker.js';
import { decodePaymentHeader, encodePaymentHeader, gatewayAuthorizationTypes, gatewayNetworkConfig,
  gatewayValidity, recoverGatewayPayer, traceOffer } from '../src/gateway-x402.js';
import { migrate } from '../src/migrate.js';
import { seedGateway } from '../src/seed.js';

async function availablePort() {
  const server=createServer();
  await new Promise<void>((resolve,reject)=>{ server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const address=server.address(); assert.ok(address && typeof address!=='string');
  await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
  return address.port;
}

test('isolated signer only issues approved testnet authorizations and retains uncertain reservations', { timeout:90_000 }, async (t)=>{
  const directory=await mkdtemp(join(tmpdir(),'agsign-'));
  const port=await availablePort(); const password=randomUUID();
  const postgres=new EmbeddedPostgres({ databaseDir:join(directory,'db'),port,password,persistent:true,
    postgresFlags:['-h','127.0.0.1','-k',directory],onLog:()=>{},onError:()=>{} });
  const pool=new Pool({ host:'127.0.0.1',port,password,user:'postgres',database:'postgres' });
  let started=false; let child: ChildProcess | undefined;
  t.after(async ()=>{ if (child && child.exitCode===null && child.signalCode===null) { const stopped=once(child,'exit'); child.kill(); await stopped; }
    await pool.end(); if(started) await postgres.stop(); await rm(directory,{recursive:true,force:true}); });
  await postgres.initialise();await postgres.start();started=true;await migrate(pool);
  const key=generatePrivateKey(); const account=privateKeyToAccount(key);
  const recipient=privateKeyToAccount(generatePrivateKey()).address;
  const serviceToken=randomBytes(32).toString('hex');
  const policy={ payer:account.address,recipients:[recipient],maxAmountUnits:1000n };
  const origin='https://merchant.example';
  const directSign=(data:SigningRequest)=>account.signTypedData({ ...data,message:{ ...data.message,
    value:BigInt(data.message.value),validAfter:BigInt(data.message.validAfter),validBefore:BigInt(data.message.validBefore) } });
  let signingCalls=0;
  const signer=buildGatewaySigner(pool,policy,serviceToken,async (data)=>{ signingCalls++;return directSign(data); });
  t.after(()=>signer.close());
  async function fixture(options:{ network?:'arc'|'arcTestnet'; payer?:Address; recipient?:Address }={}) {
    const payer=options.payer ?? account.address; const payee=options.recipient ?? recipient;
    const network=options.network ?? 'arcTestnet';
    const task=await seedGateway(pool,{origin,payer,recipient:payee,network});
    const requestId=randomUUID();
    const message={from:payer,to:payee,value:'1000',validAfter:'0',validBefore:String(Math.floor(Date.now()/1000)+gatewayValidity),
      nonce:`0x${randomBytes(32).toString('hex')}` as Hex};
    const data:SigningRequest={domain:gatewayNetworkConfig(network).domain,types:gatewayAuthorizationTypes,primaryType:'TransferWithAuthorization',message};
    await transaction(pool,async (client)=>{
      const day=(await client.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0].day;
      await reserveAmount(client,task.taskId,day,'1000');
      await client.query(`INSERT INTO gateway_demo_purchases(request_id,endpoint,nonce,payer,recipient,amount_units,
        network,task_id,budget_day,budget_status,signing_authorization)
        VALUES($1,$2,$3,$4,$5,1000,$6,$7,$8,'reserved',$9)`,
      [requestId,`${origin}/trace/${requestId}`,message.nonce,payer.toLowerCase(),payee.toLowerCase(),network,task.taskId,day,JSON.stringify(message)]);
    });
    return {requestId,task,data};
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  const invoke=(f:Fixture,app=signer)=>app.inject({method:'POST',url:'/sign-gateway-request',
    headers:{authorization:`Bearer ${serviceToken}`,'x-agent-token':f.task.token},payload:{requestId:f.requestId,taskId:f.task.taskId}});
  const row=async (f:Fixture)=>(await pool.query('SELECT * FROM gateway_demo_purchases WHERE request_id=$1',[f.requestId])).rows[0];
  await t.test('requires both service and task authority and refuses arbitrary typed data',async ()=>{
    const f=await fixture(); const before=signingCalls;
    assert.equal((await signer.inject({method:'POST',url:'/sign-gateway-request',payload:{requestId:f.requestId,taskId:f.task.taskId}})).statusCode,401);
    assert.equal((await signer.inject({method:'POST',url:'/sign-gateway-request',headers:{authorization:`Bearer ${serviceToken}`},
      payload:{requestId:f.requestId,taskId:f.task.taskId}})).statusCode,403);
    for (const extra of [{message:f.data.message},{domain:f.data.domain},{amount:'1'},{recipient:account.address},{nonce:f.data.message.nonce}]) {
      assert.equal((await signer.inject({method:'POST',url:'/sign-gateway-request',headers:{authorization:`Bearer ${serviceToken}`,'x-agent-token':f.task.token},
        payload:{requestId:f.requestId,taskId:f.task.taskId,...extra}})).statusCode,400);
    }
    const stranger=await fixture();
    assert.equal((await invoke({...f,task:stranger.task})).statusCode,403);
    assert.equal(signingCalls,before);assert.equal((await row(f)).signing_started_at,null);
  });
  await t.test('enforces chain, payer, payee, expiry and amount before key use',async ()=>{
    const before=signingCalls;
    for (const options of [{network:'arc' as const},{payer:privateKeyToAccount(generatePrivateKey()).address},
      {recipient:privateKeyToAccount(generatePrivateKey()).address}]) assert.equal((await invoke(await fixture(options))).statusCode,403);
    for (const patch of [{validBefore:'1'},{value:'2000'},{nonce:`0x${'0'.repeat(64)}`},{validAfter:'1'},
      {validBefore:String(Math.floor(Date.now()/1000)+gatewayValidity*2)}]) {
      const f=await fixture();
      await pool.query('UPDATE gateway_demo_purchases SET signing_authorization=signing_authorization || $2::jsonb WHERE request_id=$1',[f.requestId,JSON.stringify(patch)]);
      assert.equal((await invoke(f)).statusCode,409);
    }
    const f=await fixture();await pool.query('UPDATE gateway_demo_purchases SET signing_authorization=NULL WHERE request_id=$1',[f.requestId]);
    assert.equal((await invoke(f)).statusCode,409,'legacy requests cannot acquire a new validity window');
    const tight=buildGatewaySigner(pool,{...policy,maxAmountUnits:999n},serviceToken,directSign);
    try { assert.equal((await invoke(await fixture(),tight)).statusCode,403); } finally { await tight.close(); }
    assert.equal(signingCalls,before);
  });
  await t.test('concurrent retries bind one authorization and cache the signature; revocation denies cached access',async ()=>{
    const f=await fixture();const responses=await Promise.all([invoke(f),invoke(f)]);
    assert.deepEqual(responses.map((r)=>r.statusCode),[200,200]);
    assert.equal(responses[0]!.json().signature,responses[1]!.json().signature);
    assert.equal((await recoverGatewayPayer(f.data.message,responses[0]!.json().signature)).toLowerCase(),account.address.toLowerCase());
    const before=signingCalls;assert.equal((await invoke(f)).statusCode,200);assert.equal(signingCalls,before);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gateway_signatures WHERE request_id=$1',[f.requestId])).rows[0].n,1);
    await assert.rejects(pool.query("UPDATE gateway_demo_purchases SET signing_authorization=signing_authorization || '{\"value\":\"2000\"}' WHERE request_id=$1",[f.requestId]),/Cannot change/);
    await assert.rejects(pool.query('DELETE FROM gateway_demo_purchases WHERE request_id=$1',[f.requestId]),/Cannot delete/);
    await pool.query('UPDATE research_tasks SET enabled=false WHERE id=$1',[f.task.taskId]);
    assert.equal((await invoke(f)).statusCode,403);
  });
  await t.test('a failed signing attempt keeps the nonce and reservation; an exact retry can recover',async ()=>{
    const f=await fixture();const failing=buildGatewaySigner(pool,policy,serviceToken,async ()=>{throw new Error('Injected process failure');});
    try { assert.equal((await invoke(f,failing)).statusCode,503); } finally {await failing.close();}
    await transaction(pool,(client)=>releaseUnsubmittedGatewayPurchase(client,f.requestId,f.data.message.nonce,f.task.taskId));
    assert.equal((await row(f)).budget_status,'reserved');assert.ok((await row(f)).signing_started_at);
    // Make only this request due: a restart must query, never expire the reservation.
    await pool.query("UPDATE gateway_demo_purchases SET reconcile_after=now()+interval '1 day'");
    await pool.query("UPDATE gateway_demo_purchases SET reconcile_after=now()-interval '1 second' WHERE request_id=$1",[f.requestId]);
    const empty=async ()=>Response.json({transfers:[]});
    assert.equal(await processGatewayReconciliation(pool,empty),true);
    assert.equal((await row(f)).budget_status,'reserved');
    assert.equal((await invoke(f)).statusCode,200);assert.equal((await row(f)).nonce,f.data.message.nonce);
  });
  await t.test('revocation during signing prevents returning a signature without freeing uncertain funds',async ()=>{
    const f=await fixture();const racing=buildGatewaySigner(pool,policy,serviceToken,async(data)=>{
      await pool.query('UPDATE research_tasks SET enabled=false WHERE id=$1',[f.task.taskId]);return directSign(data);
    });
    try {assert.equal((await invoke(f,racing)).statusCode,403);} finally {await racing.close();}
    await transaction(pool,(client)=>releaseUnsubmittedGatewayPurchase(client,f.requestId,f.data.message.nonce,f.task.taskId));
    assert.equal((await row(f)).budget_status,'reserved');
    assert.equal((await pool.query('SELECT signature FROM gateway_signatures WHERE request_id=$1',[f.requestId])).rows[0].signature,null);
  });
  await t.test('lost signer response cannot release budget or create a replacement authorization',async ()=>{
    const task=await seedGateway(pool,{origin,payer:account.address,recipient});const requestId=randomUUID();let paidPosts=0;
    const merchant:typeof fetch=async(_url,init)=>{
      if (new Headers(init?.headers).has('payment-signature')) paidPosts++;
      return new Response(null,{status:402,headers:{'payment-required':encodePaymentHeader(traceOffer(`${origin}/trace/${requestId}`,recipient))}});
    };
    const loss:typeof fetch=async(_url,init)=>{
      const response=await signer.inject({method:'POST',url:'/sign-gateway-request',headers:Object.fromEntries(new Headers(init?.headers)),payload:JSON.parse(String(init?.body))});
      assert.equal(response.statusCode,200);throw new Error('Lost HTTP response after signature issuance');
    };
    const purchase={requestId,payer:account.address,recipient,endpoint:`${origin}/trace/${requestId}`,task:{taskId:task.taskId,agentToken:task.token}};
    await assert.rejects(purchaseGatewayTrace(pool,purchase,gatewaySignerClient('http://127.0.0.1:3004',serviceToken,requestId,purchase.task,loss),merchant),/response unavailable/);
    const original=(await pool.query('SELECT * FROM gateway_demo_purchases WHERE request_id=$1',[requestId])).rows[0];
    assert.equal(original.budget_status,'reserved');assert.equal(original.submitted_at,null);assert.equal(paidPosts,0);
    let resigned=false;
    const result=await purchaseGatewayTrace(pool,purchase,async()=>{resigned=true;return '0x';},merchant,async()=>Response.json({transfers:[]}));
    assert.equal(result.status,'submission-unknown');assert.equal(resigned,false);
    assert.equal((await pool.query('SELECT reserved FROM research_tasks WHERE id=$1',[task.taskId])).rows[0].reserved,'1000');
    // A later positive observation must still reconcile the exposed authorization.
    await checkGatewayPayment(pool,requestId,{nonce:original.nonce,payer:original.payer,recipient:original.recipient,amountUnits:'1000',network:'arcTestnet'},'worker',async()=>Response.json({transfers:[{
      id:requestId,txHash:`0x${'a'.repeat(64)}`,nonce:original.nonce,fromAddress:original.payer,toAddress:original.recipient,
      token:'USDC',sendingNetwork:gatewayNetworkConfig('arcTestnet').network,recipientNetwork:gatewayNetworkConfig('arcTestnet').network,amount:'1000',status:'confirmed',
    }]}));
    assert.equal((await pool.query('SELECT budget_status FROM gateway_demo_purchases WHERE request_id=$1',[requestId])).rows[0].budget_status,'spent');
  });
  await t.test('a separate signer process survives restart and signs a real buyer HTTP request',async ()=>{
    const keyPath=join(directory,'test-only-key');await writeFile(keyPath,key,{mode:0o600});
    let logs='';
    async function startSigner() {
      child=fork(fileURLToPath(new URL('../src/gateway-signer-server.js',import.meta.url)),[],{silent:true,env:{PATH:process.env.PATH,
        DATABASE_URL:`postgres://postgres:${password}@127.0.0.1:${port}/postgres`,GATEWAY_NETWORK:'arcTestnet',
        GATEWAY_SIGNER_KEY_FILE:keyPath,GATEWAY_SIGNER_TOKEN:serviceToken,GATEWAY_SIGNER_RECIPIENTS:recipient,GATEWAY_SIGNER_PORT:'0'}});
      child.stdout?.on('data',(chunk)=>{logs+=String(chunk);});child.stderr?.on('data',(chunk)=>{logs+=String(chunk);});
      return new Promise<number>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Signer startup timed out')),10000);
        child!.once('message',(value)=>{clearTimeout(timer);resolve((value as {port:number}).port);});
        child!.once('exit',()=>{clearTimeout(timer);reject(new Error('Signer exited before readiness'));});
      });
    }
    let signerPort=await startSigner();const f=await fixture();
    const remote=()=>gatewaySignerClient(`http://127.0.0.1:${signerPort}`,serviceToken,f.requestId,{taskId:f.task.taskId,agentToken:f.task.token});
    const signature=await remote()(f.data);
    const stopped=once(child!,'exit');child!.kill('SIGKILL');await stopped;
    signerPort=await startSigner();assert.equal(await remote()(f.data),signature);
    const task=await seedGateway(pool,{origin,payer:account.address,recipient});const requestId=randomUUID();
    const credentials={taskId:task.taskId,agentToken:task.token};
    const merchant:typeof fetch=async(_url,init)=>{
      const header=new Headers(init?.headers).get('payment-signature');
      if (!header) return new Response(null,{status:402,headers:{'payment-required':encodePaymentHeader(traceOffer(`${origin}/trace/${requestId}`,recipient))}});
      const payment=decodePaymentHeader(header);
      assert.equal((await recoverGatewayPayer(payment.payload.authorization,payment.payload.signature)).toLowerCase(),account.address.toLowerCase());
      return Response.json({requestId,nonce:payment.payload.authorization.nonce,gatewayReference:'offline-issued',trace:{source:'fixture'}});
    };
    assert.equal((await purchaseGatewayTrace(pool,{requestId,payer:account.address,recipient,endpoint:`${origin}/trace/${requestId}`,task:credentials},
      gatewaySignerClient(`http://127.0.0.1:${signerPort}`,serviceToken,requestId,credentials),merchant)).status,'delivered');
    assert.ok(!logs.includes(key));assert.ok(!logs.includes(serviceToken));assert.ok(!logs.includes(signature));assert.ok(!logs.includes(task.token));
    const closed=once(child!,'exit');child!.kill();await closed;child=undefined;
  });
});

test('signer client disallows insecure remote transports and credential-bearing URLs',()=>{
  for (const url of ['http://signer.example','https://token@signer.example','https://signer.example/?token=x','https://signer.example/sign']) {
    assert.throws(()=>gatewaySignerClient(url,'token',randomUUID(),{taskId:randomUUID(),agentToken:'agent'}),/Use HTTPS/);
  }
});

test('local launcher gives the buyer an allowlisted environment without key paths or wallet secrets',async()=>{
  const url=new URL('../../scripts/gateway-local-signer.mjs',import.meta.url).href;
  const { gatewayBuyerEnvironment }=await import(url);
  const result=gatewayBuyerEnvironment({ PATH:'/bin',DATABASE_URL:'local-database',AGENT_TOKEN:'task-token',
    GATEWAY_SIGNER_TOKEN:'service-token',GATEWAY_SIGNER_URL:'http://127.0.0.1:3004',
    GATEWAY_SIGNER_KEY_FILE:'private-key-path',GATEWAY_TESTNET_SIGNER_FILE:'legacy-key-path',
    GATEWAY_MERCHANT_KEY:'merchant-secret',UNRELATED_SECRET:'unrelated-secret' });
  assert.deepEqual(result,{PATH:'/bin',DATABASE_URL:'local-database',AGENT_TOKEN:'task-token',
    GATEWAY_SIGNER_TOKEN:'service-token',GATEWAY_SIGNER_URL:'http://127.0.0.1:3004'});
});
