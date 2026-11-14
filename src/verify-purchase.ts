import { Pool } from 'pg';
import { collectPurchaseEvidence } from './purchase-evidence.js';
import { baseReconciliationChain } from './reconciliation.js';

const { DATABASE_URL, BASE_SEPOLIA_RPC_URL, AGENT_TOKEN, TASK_ID, SERVICE_ID,
  API_URL = 'http://127.0.0.1:3000' } = process.env;
const requestId = process.argv[2];
if (!DATABASE_URL || !BASE_SEPOLIA_RPC_URL || !AGENT_TOKEN || !TASK_ID || !SERVICE_ID ||
    !requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) {
  throw new Error('Set the database, RPC and research client variables, then supply a stable purchase UUID');
}

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
try {
  const chain = await baseReconciliationChain(BASE_SEPOLIA_RPC_URL);
  // Check the evidence sources before allowing the client to start a purchase.
  await Promise.all([chain.finalized(), pool.query('SELECT 1 FROM reconciliation_runs LIMIT 1')]);
  const evidence = await collectPurchaseEvidence(pool, chain, {
    apiUrl: API_URL, token: AGENT_TOKEN, taskId: TASK_ID, serviceId: SERVICE_ID, requestId,
  });
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.status === 'FAILED') process.exitCode = 2;
} catch {
  console.error(`Purchase verification failed. Check the API, worker and RPC logs, then resume with the same UUID: ${requestId}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
