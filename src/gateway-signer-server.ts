import { readFile, stat } from 'node:fs/promises';
import { Pool } from 'pg';
import { isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildGatewaySigner } from './gateway-signer.js';

const { DATABASE_URL,GATEWAY_SIGNER_KEY_FILE,GATEWAY_SIGNER_TOKEN,GATEWAY_SIGNER_RECIPIENTS }=process.env;
if (!DATABASE_URL || !GATEWAY_SIGNER_KEY_FILE || !GATEWAY_SIGNER_TOKEN || !GATEWAY_SIGNER_RECIPIENTS) {
  throw new Error('Set DATABASE_URL, GATEWAY_SIGNER_KEY_FILE, GATEWAY_SIGNER_TOKEN and GATEWAY_SIGNER_RECIPIENTS');
}
if (process.env.GATEWAY_NETWORK && process.env.GATEWAY_NETWORK!=='arcTestnet') throw new Error('Signer supports Arc testnet only');
const mode=(await stat(GATEWAY_SIGNER_KEY_FILE)).mode;
if (process.platform!=='win32' && (mode & 0o077)!==0) throw new Error('Signing key file must not be accessible to group or others');
const key=(await readFile(GATEWAY_SIGNER_KEY_FILE,'utf8')).trim();
if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error('Invalid signing key file');
const account=privateKeyToAccount(key as Hex);
const recipients=GATEWAY_SIGNER_RECIPIENTS.split(',').map((value)=>value.trim());
if (recipients.some((value)=>!isAddress(value))) throw new Error('Invalid signer recipients');
const limit=process.env.GATEWAY_SIGNER_MAX_AMOUNT_UNITS ?? '1000';
if (!/^[1-9][0-9]{0,17}$/.test(limit)) throw new Error('Invalid signing amount limit');
const pool=new Pool({ connectionString:DATABASE_URL,connectionTimeoutMillis:3000,statement_timeout:5000,
  idle_in_transaction_session_timeout:5000 });
const app=buildGatewaySigner(pool,{ payer:account.address,recipients:recipients as Address[],maxAmountUnits:BigInt(limit) },
  GATEWAY_SIGNER_TOKEN, async (data)=>account.signTypedData({ ...data,message:{ ...data.message,
    value:BigInt(data.message.value),validAfter:BigInt(data.message.validAfter),validBefore:BigInt(data.message.validBefore) } }),true);
pool.on('error',()=>app.log.error({ event:'signer_database_connection_error' }));
app.addHook('onClose',()=>pool.end());
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{ void app.close(); });
try {
  await app.listen({ host:'127.0.0.1',port:Number(process.env.GATEWAY_SIGNER_PORT ?? 3004) });
  const address=app.server.address();
  if (address && typeof address!=='string') process.send?.({ type:'ready',port:address.port });
} catch {
  app.log.error({ event:'signer_startup_failed' });
  await app.close();process.exitCode=1;
}
