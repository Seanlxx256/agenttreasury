import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildGatewayMerchant } from '../dist/src/gateway-merchant.js';
import { collectGatewayPurchaseEvidence } from '../dist/src/gateway-purchase-evidence.js';
import { purchaseGatewayTrace } from '../dist/src/gateway-purchase.js';
import { arcGatewayNetwork } from '../dist/src/gateway-x402.js';
import { migrate } from '../dist/src/migrate.js';
import { seedGateway } from '../dist/src/seed.js';

// Fully offline replay of the Gateway lost-response drill. The merchant, buyer, and
// verification paths are the production code; only the network boundary is replaced:
//   - Gateway settle and transfer lookup are answered by a deterministic mock.
//   - The batch receipt lookup returns a confirmed receipt.
//   - The paid response is dropped once to reproduce a lost delivery.

const OFFLINE_TX_HASH = `0x${'ab'.repeat(32)}`;
const dbPort = 55434;
const merchantPort = 3102;
const requestId = randomUUID();

const root = fileURLToPath(new URL('../.gateway-offline/', import.meta.url));
const databaseDir = join(root, 'db');

const payerAccount = privateKeyToAccount(generatePrivateKey());
const payer = payerAccount.address;
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const origin = `http://127.0.0.1:${merchantPort}`;
const endpoint = `${origin}/trace/${requestId}`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// The seller's facilitator call. Success is fixed; payer and network must match the
// authorization the buyer signed.
function mockSettle() {
  return async () => jsonResponse({ success: true, network: arcGatewayNetwork, payer, transaction: OFFLINE_TX_HASH });
}

// The buyer's nonce lookup. Reads the nonce off the request so the same mock works
// for whatever nonce the buyer generated, and reports a confirmed charge.
function mockTransfers() {
  return async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (!pathname.endsWith('/transfers')) throw new Error(`Unexpected Gateway call: ${pathname}`);
    return jsonResponse({
      transfers: [{
        id: 'offline-transfer', txHash: OFFLINE_TX_HASH, nonce: searchParams.get('nonce'),
        fromAddress: payer, toAddress: recipient, token: 'USDC',
        sendingNetwork: arcGatewayNetwork, recipientNetwork: arcGatewayNetwork,
        amount: '1000', status: 'confirmed',
      }],
    });
  };
}

// The verification path's batch receipt lookup.
async function mockReceipt() {
  return { status: 'success', blockNumber: 123456n };
}

async function sign(typedData) {
  return payerAccount.signTypedData({
    ...typedData,
    message: {
      ...typedData.message,
      value: BigInt(typedData.message.value),
      validAfter: BigInt(typedData.message.validAfter),
      validBefore: BigInt(typedData.message.validBefore),
    },
  });
}

await mkdir(root, { recursive: true, mode: 0o700 });
if (!existsSync(join(root, 'db-password'))) {
  await writeFile(join(root, 'db-password'), randomBytes(32).toString('hex'), { mode: 0o600 });
}
const password = (await readFile(join(root, 'db-password'), 'utf8')).trim();

const database = new EmbeddedPostgres({
  databaseDir, port: dbPort, password, authMethod: 'scram-sha-256', persistent: true,
  postgresFlags: ['-h', '127.0.0.1', '-k', root], onLog: () => {},
});
const pool = new pg.Pool({
  host: '127.0.0.1', port: dbPort, user: 'postgres', database: 'postgres', password,
  connectionTimeoutMillis: 3000,
});

let merchant;
try {
  if (!existsSync(join(databaseDir, 'PG_VERSION'))) await database.initialise();
  await database.start();
  await migrate(pool);

  const task = await seedGateway(pool, { origin, payer, recipient });
  const purchase = {
    requestId, endpoint, payer, recipient,
    task: { taskId: task.taskId, agentToken: task.token },
  };

  merchant = buildGatewayMerchant(pool, origin, recipient, mockSettle());
  merchant.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'POST' && request.url === `/trace/${requestId}` && reply.statusCode === 200) {
      reply.hijack();
      reply.raw.destroy();
      console.log('  dropped the paid response (simulated network loss)');
    }
    return payload;
  });
  await merchant.listen({ host: '127.0.0.1', port: merchantPort });

  console.log('Gateway offline drill');
  console.log(`  payer: ${payer}`);
  console.log(`  merchant: ${recipient}`);
  console.log(`  request: ${requestId}`);

  const first = await purchaseGatewayTrace(pool, purchase, sign, fetch, mockTransfers());
  console.log(`  buy 1: ${first.status}`);

  const second = await purchaseGatewayTrace(pool, purchase, sign, fetch, mockTransfers());
  console.log(`  buy 2: ${second.status}`);

  const evidence = await collectGatewayPurchaseEvidence(pool, requestId, mockReceipt, mockTransfers());
  console.log(`  verify: ${evidence.status}`);
  console.log(JSON.stringify(evidence, null, 2));

  if (first.status !== 'submission-unknown' || second.status !== 'delivered' || evidence.status !== 'PASSED') {
    process.exitCode = 2;
  }
} finally {
  try {
    await merchant?.close();
  } finally {
    try {
      await pool.end();
    } finally {
      await database.stop();
    }
  }
}
