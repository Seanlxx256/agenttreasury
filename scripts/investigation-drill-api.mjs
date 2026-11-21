// Internal child for the isolated drill. No dotenv or production connection URL.
import pg from 'pg';
import { buildApp } from '../dist/src/app.js';

if (!process.send || !process.env.DRILL_DATABASE_CONFIG || !process.env.DRILL_OPERATIONS_TOKEN) {
  throw new Error('Launch this child through drill:investigation');
}
const config = JSON.parse(process.env.DRILL_DATABASE_CONFIG);
if (config.host !== '127.0.0.1') throw new Error('Loopback database required');
process.env.GATEWAY_INVESTIGATION_MODE = 'guided';
// The selected fixture needs local reads only. Unexpected model/provider fetches
// are rejected and reported to the parent rather than reaching the network.
globalThis.fetch = async () => { process.send?.({ event: 'unexpected-fetch' }); throw new Error('External fetch forbidden in drill'); };
const pool = new pg.Pool({ ...config, max: 4, connectionTimeoutMillis: 3000 });
const wrapped = new Proxy(pool, { get(target, key) {
  if (key === 'connect') return async () => {
    const client = await target.connect();
    return new Proxy(client, { get(connection, property) {
      if (property === 'query') return async (sql, values) => {
        const result = await connection.query(sql, values);
        if (process.env.DRILL_PAUSE_FIRST_SAVE === 'true'
          && typeof sql === 'string' && sql.startsWith('UPDATE gateway_investigation_checkpoints SET progress=')
          && JSON.parse(String(values?.[1])).checks.length === 1) {
          process.send?.({ event: 'checkpoint-saved', checkpointId: values[0] });
          await new Promise(() => {});
        }
        return result;
      };
      const value = Reflect.get(connection, property, connection);
      return typeof value === 'function' ? value.bind(connection) : value;
    } });
  };
  const value = Reflect.get(target, key, target);
  return typeof value === 'function' ? value.bind(target) : value;
} });
const app = buildApp(wrapped, false, undefined, undefined, false, process.env.DRILL_OPERATIONS_TOKEN);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await app.close(); await pool.end(); process.disconnect?.();
}
process.on('message', (message) => { if (message?.event === 'shutdown') void close(); });
try {
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  process.send({ event: 'ready', url });
} catch { process.send?.({ event: 'failed' }); await close(); process.exitCode = 1; }
