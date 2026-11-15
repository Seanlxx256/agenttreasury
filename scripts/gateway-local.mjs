import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { isAddress } from 'viem';
import { buildGatewayMerchant } from '../dist/src/gateway-merchant.js';
import { gatewayDemoConfig, requestIdPattern } from '../dist/src/gateway-x402.js';
import { migrate } from '../dist/src/migrate.js';
import { seedGateway } from '../dist/src/seed.js';

const [mode, suppliedId, ...extra] = process.argv.slice(2);
if (!['prepare', 'buy', 'verify'].includes(mode) || extra.length ||
    (suppliedId !== undefined && !requestIdPattern.test(suppliedId)) ||
    (mode === 'verify' && !suppliedId) || (mode === 'prepare' && suppliedId)) {
  throw new Error('Usage: npm run gateway:local -- prepare | buy [request-id] | verify <request-id>');
}

const payer = process.env.GATEWAY_PAYER_ADDRESS;
const merchant = mode === 'buy' ? gatewayDemoConfig() : undefined;
if (merchant && (!payer || !isAddress(payer) || payer.toLowerCase() === merchant.recipient.toLowerCase())) {
  throw new Error('Set GATEWAY_PAYER_ADDRESS and GATEWAY_MERCHANT_RECIPIENT to distinct Arc testnet addresses');
}

const root = fileURLToPath(new URL('../.gateway-local/', import.meta.url));
const databaseDir = join(root, 'db');
const dbPort = Number(process.env.GATEWAY_DB_PORT ?? 55433);
if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) throw new Error('Invalid GATEWAY_DB_PORT');
await mkdir(root, { recursive: true, mode: 0o700 });
await saveNew(join(root, 'db-password'), randomBytes(32).toString('hex'));
const password = await readFile(join(root, 'db-password'), 'utf8');
const database = new EmbeddedPostgres({
  databaseDir, port: dbPort, password, authMethod: 'scram-sha-256', persistent: true,
  postgresFlags: ['-h', '127.0.0.1', '-k', root],
  onLog: () => {},
});
const pool = new pg.Pool({
  host: '127.0.0.1', port: dbPort, user: 'postgres', database: 'postgres', password,
  connectionTimeoutMillis: 3000,
});
const localCircleBin = fileURLToPath(new URL('../.finance-local/circle-cli/node_modules/.bin/', import.meta.url));
const env = {
  ...process.env,
  PATH: [localCircleBin, process.env.PATH].filter(Boolean).join(delimiter),
  DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${dbPort}/postgres`,
};
const abort = new AbortController();
const interrupt = () => abort.abort();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, interrupt);

let started = false;
let app;
try {
  if (!existsSync(join(databaseDir, 'PG_VERSION'))) await database.initialise();
  await database.start();
  started = true;
  await migrate(pool);
  abort.signal.throwIfAborted();

  if (mode === 'prepare') {
    console.log(`Local Gateway PostgreSQL initialized and migrated on port ${dbPort}.`);
  } else if (mode === 'verify') {
    process.exitCode = await run('verify-gateway-purchase.js', suppliedId);
  } else {
    const requestId = suppliedId ?? randomUUID();
    console.log(`Purchase request ID: ${requestId}`);
    console.log(`Verify this purchase: npm run gateway:local -- verify ${requestId}`);
    app = buildGatewayMerchant(pool, merchant.origin, merchant.recipient);
    await app.listen({ host: '127.0.0.1', port: merchant.port });
    const taskFile = join(root, `${requestId}.json`);
    if (!existsSync(taskFile)) {
      const task = await seedGateway(pool, { origin: merchant.origin, payer, recipient: merchant.recipient });
      await saveNew(taskFile, JSON.stringify({ taskId: task.taskId, token: task.token }));
    }
    const task = JSON.parse(await readFile(taskFile, 'utf8'));
    env.GATEWAY_TASK_ID = task.taskId;
    env.AGENT_TOKEN = task.token;
    const result = await run('buy-gateway-trace.js', requestId);
    process.exitCode = result === 0 ? await run('verify-gateway-purchase.js', requestId) : result;
  }
} finally {
  try {
    await app?.close();
  } finally {
    try {
      await pool.end();
    } finally {
      if (started) await database.stop();
    }
  }
}

async function saveNew(path, contents) {
  try {
    await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function run(entry, requestId) {
  const script = fileURLToPath(new URL(`../dist/src/${entry}`, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, requestId], { env, stdio: 'inherit', signal: abort.signal });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}
