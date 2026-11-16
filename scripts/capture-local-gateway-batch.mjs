import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { captureProjectBatch } from '../dist/src/capture-gateway-project-batch.js';

const args=process.argv.slice(2);
const finance=args[0]==='--finance';
if(finance)args.shift();
const [output,requestId,...extra]=args;
if (!output || extra.length || (requestId && !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(requestId))) {
  throw new Error('Usage: node scripts/capture-local-gateway-batch.mjs [--finance] <new-file> [existing-request-id]');
}
const root=new URL(finance?'../.finance-local/':'../.gateway-local/',import.meta.url);
if (!existsSync(new URL('db/PG_VERSION',root))) throw new Error('Existing local Gateway database required; this script never initializes or migrates it');
const password=finance?JSON.parse(await readFile(new URL('credentials.json',root),'utf8')).password
  :await readFile(new URL('db-password',root),'utf8');
const pid=new URL('db/postmaster.pid',root);
const runningPort=existsSync(pid)?(await readFile(pid,'utf8')).split('\n')[3]?.trim():undefined;
const port=Number((finance?process.env.FINANCE_DB_PORT:process.env.GATEWAY_DB_PORT)??runningPort??(finance?55432:55433));
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid local database port');
const database=new EmbeddedPostgres({databaseDir:fileURLToPath(new URL('db',root)),port,password,persistent:true,
  postgresFlags:['-h','127.0.0.1','-k',fileURLToPath(root)],onLog:()=>{},onError:()=>{}});
const pool=new Pool({host:'127.0.0.1',port,user:'postgres',database:'postgres',password,
  connectionTimeoutMillis:3000,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
let started=false;
let stage='connect';
try {
  try {await pool.query('SELECT 1');}
  catch(error) {
    if (error.code!=='ECONNREFUSED') throw error;
    await database.start();started=true;
  }
  stage='select-existing-purchase';
  const id=requestId??(await pool.query(`SELECT p.request_id FROM gateway_demo_purchases p
    JOIN gateway_payment_journal j USING(request_id) WHERE coalesce(to_jsonb(p)->>'network','arcTestnet')='arcTestnet' ORDER BY j.posted_at DESC LIMIT 1`)).rows[0]?.request_id;
  if (!id) throw new Error('No existing testnet journal posting found');
  stage='capture-evidence';
  const evidence=await captureProjectBatch(pool,id);
  await writeFile(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({output,requestId:id,status:evidence.result.status,linkage:evidence.linkage}));
} catch(error) {
  // Avoid logging RPC URLs, database passwords or vendor response bodies.
  console.error(JSON.stringify({status:'failed',stage,errorType:error.name??'Error',code:error.code??null,
    message:'No payment or migration was attempted.'}));
  process.exitCode=1;
} finally {await pool.end();if(started)await database.stop();}
