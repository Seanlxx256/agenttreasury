// Disposable test child. It pauses only after PostgreSQL confirms a saved check;
// the parent kills this process to exercise real session-lock crash release.
import { Pool } from 'pg';
import { resumeInvestigationCheckpoint } from '../src/gateway-investigation-checkpoints.js';

const pool = new Pool({ ...JSON.parse(process.env.TEST_DATABASE_CONFIG!), max: 1 });
const wrapped = new Proxy(pool, { get(target, key) {
  if (key === 'connect') return async () => {
    const client = await target.connect();
    return new Proxy(client, { get(connection, property) {
      if (property === 'query') return async (sql: string, values?: unknown[]) => {
        const result = await connection.query(sql, values);
        if (sql.startsWith('UPDATE gateway_investigation_checkpoints SET progress=')
          && JSON.parse(String(values?.[1])).checks.length === 1) {
          process.send?.({ event: 'checkpoint-saved' });
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
try {
  await resumeInvestigationCheckpoint(wrapped, process.env.TEST_REQUEST_ID!, process.env.TEST_CHECKPOINT_ID!, 'operations', {
    modelRequest: async () => Response.json({ message: { content: '{"next":"read-local-journal"}' } }),
    gatewayRequest: async () => { throw new Error('Unexpected external request'); },
    chainRead: async () => { throw new Error('Unexpected chain read'); },
  });
  process.send?.({ event: 'unexpected-completion' });
} catch { process.send?.({ event: 'worker-failed' }); process.exitCode = 1; }
finally { await pool.end(); }
