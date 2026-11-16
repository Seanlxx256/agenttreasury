import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function gatewayBuyerEnvironment(environment) {
  const keys = ['PATH', 'DATABASE_URL', 'GATEWAY_NETWORK', 'GATEWAY_API', 'ARC_TESTNET_RPC_URL',
    'GATEWAY_PAYER_ADDRESS', 'GATEWAY_MERCHANT_RECIPIENT', 'GATEWAY_MERCHANT_PORT',
    'GATEWAY_TASK_ID', 'AGENT_TOKEN', 'GATEWAY_SIGNER_URL', 'GATEWAY_SIGNER_TOKEN'];
  return Object.fromEntries(keys.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]));
}

// The launcher passes a path to a separate process; it never reads key bytes.
export async function startLocalGatewaySigner(databaseUrl, keyFile, recipient) {
  const token = randomBytes(32).toString('hex');
  const child = fork(fileURLToPath(new URL('../dist/src/gateway-signer-server.js', import.meta.url)), [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, GATEWAY_NETWORK: 'arcTestnet',
      GATEWAY_SIGNER_KEY_FILE: resolve(keyFile), GATEWAY_SIGNER_TOKEN: token,
      GATEWAY_SIGNER_RECIPIENTS: recipient, GATEWAY_SIGNER_PORT: '0' },
  });
  async function close() {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  try {
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('Gateway signer startup timed out')), 10000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('Gateway signer could not start')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Gateway signer exited before readiness')); });
      child.once('message', (message) => {
        clearTimeout(timer);
        if (message?.type !== 'ready' || !Number.isInteger(message.port) || message.port < 1) {
          reject(new Error('Invalid Gateway signer readiness response'));
        } else resolvePort(message.port);
      });
    });
    return { url: `http://127.0.0.1:${port}`, token, close };
  } catch (error) { await close(); throw error; }
}
