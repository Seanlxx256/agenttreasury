import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { buildApp } from '../dist/src/app.js';
import { operationsCacheFromEnv } from '../dist/src/operations-cache.js';
import { migrate } from '../dist/src/migrate.js';
import { merchantConfig } from '../dist/src/merchant.js';

const home = new URL('../.finance-local/', import.meta.url);
mkdirSync(home, { recursive: true, mode: 0o700 });
const settings = new URL('credentials.json', home);
if (!existsSync(settings)) {
  try {
    writeFileSync(settings, JSON.stringify({
      password: randomBytes(32).toString('hex'),
      financeToken: randomBytes(32).toString('hex'),
    }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
const { password, financeToken } = JSON.parse(readFileSync(settings, 'utf8'));
const dbDir = new URL('db/', home);
const pidFile = new URL('postmaster.pid', dbDir);
const runningPort = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split('\n')[3]?.trim() : undefined;
const port = Number(process.env.FINANCE_DB_PORT ?? (runningPort || 55432));
const apiPort = Number(process.env.PORT ?? 3000);
const database = new EmbeddedPostgres({
  databaseDir: fileURLToPath(dbDir),
  port, password, authMethod: 'scram-sha-256', persistent: true,
  postgresFlags: ['-h', '127.0.0.1', '-k', fileURLToPath(home)],
  onLog(message) {
    if (/FATAL:.*(?:lock file|could not bind|could not create.*socket)/.test(message)) {
      console.error(message.split('\n')[0]);
    }
  },
  onError() {},
});
const pool = new pg.Pool({
  host: '127.0.0.1', port, user: 'postgres', database: 'postgres', password,
  connectionTimeoutMillis: 3000, statement_timeout: 5000,
});
pool.on('error', () => console.error('Local database connection interrupted.'));

async function reuseLocalDatabase() {
  if (!runningPort) return false;
  if (port !== Number(runningPort)) {
    throw new Error('The existing finance database uses port ' + runningPort + '. Start without overriding FINANCE_DB_PORT.');
  }
  let rows;
  try {
    ({ rows } = await pool.query('SHOW data_directory'));
  } catch (error) {
    if (error.code === 'ECONNREFUSED') return false;
    throw new Error('Could not connect to the existing finance database on port ' + port + '.', { cause: error });
  }
  if (realpathSync(rows[0].data_directory) !== realpathSync(dbDir)) {
    throw new Error('Port ' + port + ' belongs to a different PostgreSQL database.');
  }
  return true;
}

let started = false;
let app;
let closing;
function close() {
  closing ??= (async () => {
    try {
      await app?.close();
    } finally {
      try {
        await pool.end();
      } finally {
        if (started) await database.stop();
      }
    }
  })();
  return closing;
}

try {
  if (!existsSync(new URL('PG_VERSION', dbDir))) await database.initialise();
  if (await reuseLocalDatabase()) {
    console.log('Using the existing local finance database.');
  } else {
    await database.start();
    started = true;
  }
  await migrate(pool);
  const token = process.env.FINANCE_APPROVAL_TOKEN || financeToken;
  const delivery = process.env.MERCHANT_ENDPOINT ? { merchant: merchantConfig() } : undefined;
  app = buildApp(pool, false, delivery, token, true, process.env.GATEWAY_OPERATIONS_TOKEN, operationsCacheFromEnv());
  const address = await app.listen({ host: '127.0.0.1', port: apiPort });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      close().catch(() => { process.exitCode = 1; });
    });
  }
  console.log(`Finance console: ${address}/finance`);
  if (process.platform === 'darwin') {
    const copy = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] });
    copy.on('error', () => {});
    copy.stdin.on('error', () => {});
    copy.on('close', (code) => {
      if (code === 0) console.log('Finance token copied to the clipboard.');
      else console.log('Find the finance token in .finance-local/credentials.json or FINANCE_APPROVAL_TOKEN.');
    });
    copy.stdin.end(token);
  } else {
    console.log('Find the finance token in .finance-local/credentials.json or FINANCE_APPROVAL_TOKEN.');
  }
} catch (error) {
  if (error?.code === 'EADDRINUSE') {
    console.error('Finance console port ' + apiPort + ' is in use. Choose another port with PORT=<port> npm run finance:local.');
  } else {
    console.error('Local finance startup failed:', error?.message ?? 'PostgreSQL could not start on port ' + port + '.');
  }
  process.exitCode = 1;
  await close();
}
