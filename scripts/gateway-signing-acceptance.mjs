import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { gatewayBuyerEnvironment, startLocalGatewaySigner } from './gateway-local-signer.mjs';
import { migrate } from '../dist/src/migrate.js';
import { seedGateway } from '../dist/src/seed.js';
import { buildGatewayMerchant } from '../dist/src/gateway-merchant.js';
import { checkGatewayPayment } from '../dist/src/gateway-payment-evidence.js';
import { collectSigningAcceptance } from '../dist/src/gateway-signing-acceptance.js';
import { captureProjectBatch } from '../dist/src/capture-gateway-project-batch.js';
import { verifyProjectBatchEvidence } from '../dist/src/gateway-project-batch-evidence.js';
import { verifyModernSigningAcceptance } from '../dist/src/verify-gateway-signing-acceptance.js';
import { evidenceDigest } from '../dist/src/gateway-balance-evidence.js';

const [mode,output,...extra]=process.argv.slice(2);
if(!['purchase','check','capture'].includes(mode)||extra.length||(mode==='capture'?!output:!!output))
  throw new Error('Usage: npm run acceptance:gateway-signing -- purchase | check | capture <new-file>');
if(process.env.GATEWAY_NETWORK && process.env.GATEWAY_NETWORK!=='arcTestnet')throw new Error('Testnet only');
if(process.env.GATEWAY_API || process.env.GATEWAY_SIGNER_URL)throw new Error('Acceptance pins the official testnet Gateway and a local signer');
const root=new URL('../.gateway-acceptance/',import.meta.url);
const manifestFile=new URL('manifest.json',root);
const keyFile=fileURLToPath(new URL('../.gateway-local/payer-key',import.meta.url));
const archive=JSON.parse(await readFile(new URL('../docs/evidence/stage-5-project-batch.json',import.meta.url),'utf8'));
verifyProjectBatchEvidence(archive);
await mkdir(root,{recursive:true,mode:0o700});
if(!existsSync(manifestFile)) {
  if(mode!=='purchase')throw new Error('No acceptance request exists; run purchase once');
  const manifest={version:1,requestId:randomUUID(),payer:archive.purchase.payer,recipient:archive.purchase.recipient,
    dbPort:await freePort(),merchantPort:await freePort(),maxAmountUnits:'1000',createdAt:new Date().toISOString()};
  await writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  await writeFile(new URL('db-password',root),randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
}
const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
if(manifest.payer!==archive.purchase.payer||manifest.recipient!==archive.purchase.recipient||manifest.maxAmountUnits!=='1000')
  throw new Error('Acceptance manifest terms changed');
const password=await readFile(new URL('db-password',root),'utf8');
const databaseDir=fileURLToPath(new URL('db',root));
const database=new EmbeddedPostgres({databaseDir,port:manifest.dbPort,password,persistent:true,
  postgresFlags:['-h','127.0.0.1','-k',fileURLToPath(root)],onLog:()=>{},onError:()=>{}});
const pool=new Pool({host:'127.0.0.1',port:manifest.dbPort,user:'postgres',database:'postgres',password,
  connectionTimeoutMillis:3000,statement_timeout:10000});
let started=false,merchant,signer;
try {
  if(!existsSync(new URL('db/PG_VERSION',root)))await database.initialise();
  await database.start();started=true;
  await migrate(pool); // Only this isolated acceptance database, never the user's old stores.
  const origin=`http://127.0.0.1:${manifest.merchantPort}`;
  const existing=(await pool.query('SELECT 1 FROM gateway_demo_purchases WHERE request_id=$1',[manifest.requestId])).rowCount;
  if(mode==='purchase' && !existing) {
    const taskFile=new URL('task.json',root);
    if(!existsSync(taskFile)) {
      const task=await seedGateway(pool,{origin,payer:manifest.payer,recipient:manifest.recipient,network:'arcTestnet'},1000,1000);
      await writeFile(taskFile,JSON.stringify({taskId:task.taskId,token:task.token}),{flag:'wx',mode:0o600});
    }
    const task=JSON.parse(await readFile(taskFile,'utf8'));
    merchant=buildGatewayMerchant(pool,origin,manifest.recipient);
    await merchant.listen({host:'127.0.0.1',port:manifest.merchantPort});
    const databaseUrl=`postgresql://postgres:${password}@127.0.0.1:${manifest.dbPort}/postgres`;
    signer=await startLocalGatewaySigner(databaseUrl,keyFile,manifest.recipient);
    const env=gatewayBuyerEnvironment({PATH:process.env.PATH,DATABASE_URL:databaseUrl,GATEWAY_NETWORK:'arcTestnet',
      GATEWAY_PAYER_ADDRESS:manifest.payer,GATEWAY_MERCHANT_RECIPIENT:manifest.recipient,GATEWAY_MERCHANT_PORT:String(manifest.merchantPort),
      GATEWAY_TASK_ID:task.taskId,AGENT_TOKEN:task.token,GATEWAY_SIGNER_URL:signer.url,GATEWAY_SIGNER_TOKEN:signer.token});
    const buyerExit=await runBuyer(env,manifest.requestId);
    console.log(JSON.stringify({event:'buyer-completed',requestId:manifest.requestId,buyerExit,maxAmountUnits:'1000'}));
  }
  const {rows:[purchase]}=await pool.query(`SELECT nonce,payer,recipient,network,amount_units::text AS "amountUnits"
    FROM gateway_demo_purchases WHERE request_id=$1`,[manifest.requestId]);
  if(!purchase)throw new Error('Buyer created no purchase; no retry was performed');
  const payment=await checkGatewayPayment(pool,manifest.requestId,purchase,'operations');
  const signing=await collectSigningAcceptance(pool,manifest.requestId);
  const status={requestId:manifest.requestId,checkedAt:new Date().toISOString(),payment,signing};
  await writeFile(new URL('status.json',root),JSON.stringify(status,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({requestId:manifest.requestId,payment:payment.status,signingVerified:signing.signingVerified,
    signatureRows:signing.signatureRows,journalRows:signing.journalRows,budget:signing.budget,delivery:signing.delivery}));
  if(mode==='capture') {
    if(payment.status!=='charged'||!signing.signingVerified||signing.journalRows!==1||
      signing.budget.spent!=='1000'||signing.budget.reserved!=='0'||!signing.delivery.buyer||!signing.delivery.seller||
      signing.delivery.commitmentSatisfied!==true)throw new Error('Acceptance is not fully settled and delivered');
    const batch=await captureProjectBatch(pool,manifest.requestId);
    const verified=verifyProjectBatchEvidence(batch);
    if(verified.report.status!=='MATCHED'||verified.linkage[0]?.status!=='corroborated')throw new Error('Batch linkage did not pass');
    const report={version:1,scope:'modern-signing-testnet-acceptance',capturedAt:new Date().toISOString(),signing,batch,
      execution:{buyerExecutable:'buy-gateway-trace.js',separateSigner:true,maxAmountUnits:'1000',merchant:'project-operated-fixture'}};
    const captured=JSON.parse(JSON.stringify({...report,digest:evidenceDigest(report)}));
    verifyModernSigningAcceptance(captured);
    await writeFile(output,JSON.stringify(captured,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({event:'acceptance-captured',output,requestId:manifest.requestId}));
  }
} catch(error) {
  console.error(JSON.stringify({status:'failed',errorType:error.name??'Error',code:error.code??null,
    message:'Inspect the same durable request; do not delete its manifest or create a replacement payment.'}));process.exitCode=1;
} finally {
  await merchant?.close();await signer?.close();await pool.end();if(started)await database.stop();
}
async function freePort() {
  const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));return port;
}
function runBuyer(env,id) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/src/buy-gateway-trace.js',import.meta.url)),id],
      {env,stdio:['ignore','ignore','ignore'],timeout:90000});
    child.once('error',reject);child.once('exit',(code)=>resolve(code??1));
  });
}
