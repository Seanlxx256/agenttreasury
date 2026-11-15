import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createWalletClient, erc20Abi, http, parseAbi, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arcTestnetClient, arcTestnetUsdc, gatewayChainConfig, gatewayCircleChain, gatewayDomain, gatewayRpcUrl, gatewaySessionKey } from '../dist/src/gateway-x402.js';

const [mode, amount, ...rest] = process.argv.slice(2);
const validInspection = (mode === 'init' || mode === 'status') && amount === undefined;
const validDeposit = mode === 'deposit' && /^\d+(?:\.\d{1,6})?$/.test(amount ?? '');
if (rest.length || !(validInspection || validDeposit)) {
  throw new Error('Usage: npm run gateway:wallet -- init | status | deposit <test-usdc>');
}

const directory = new URL('../.gateway-local/', import.meta.url);
const keyFile = new URL('payer-key', directory);

if (mode === 'status') {
  await reportStatus();
} else {
  if (mode === 'init') {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(keyFile, generatePrivateKey(), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  const account = privateKeyToAccount((await readFile(keyFile, 'utf8')).trim());
  if (mode === 'init') {
    console.log(`Arc payer: ${account.address}`);
    console.log(`Signing key file: ${fileURLToPath(keyFile)}`);
    console.log('Gateway batch settlement can only be signed by an EOA, so this key stays the payer.');
    console.log('A Circle Agent Wallet can hold funds but cannot sign that batch: npm run gateway:wallet -- status');
  } else {
    const value = parseUnits(amount, 6);
    if (value <= 0n) throw new Error('Deposit amount must be positive');
    const chain = arcTestnetClient();
    if (await chain.getChainId() !== gatewayChainConfig.id) throw new Error('RPC endpoint must serve the selected Arc network');
    const wallet = createWalletClient({ account, chain: gatewayChainConfig, transport: http(process.env.ARC_TESTNET_RPC_URL ?? gatewayRpcUrl, {
      timeout: 5000, retryCount: 0,
    }) });
    const gateway = gatewayDomain.verifyingContract;
    const allowance = await chain.readContract({
      abi: erc20Abi, address: arcTestnetUsdc, functionName: 'allowance', args: [account.address, gateway],
    });
    if (allowance < value) {
      const hash = await wallet.writeContract({ abi: erc20Abi, address: arcTestnetUsdc,
        functionName: 'approve', args: [gateway, value] });
      await confirm(hash, 'Approval');
    }
    const hash = await wallet.writeContract({
      abi: parseAbi(['function deposit(address token, uint256 value)']), address: gateway,
      functionName: 'deposit', args: [arcTestnetUsdc, value],
    });
    await confirm(hash, 'Deposit');

    async function confirm(hash, label) {
      console.log(`${label} transaction: ${hash}`);
      const receipt = await chain.waitForTransactionReceipt({ hash, timeout: 30000 });
      if (receipt.status !== 'success') throw new Error(`${label} reverted`);
    }
  }
}

function circleCli() {
  const candidates = [
    process.env.CIRCLE_CLI,
    fileURLToPath(new URL('../.finance-local/circle-cli/node_modules/.bin/circle', import.meta.url)),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function readCircle(cli, args) {
  const result = spawnSync(cli, args, { encoding: 'utf8', timeout: 20000 });
  if (result.error) return { error: result.error.message };
  if (result.status !== 0) return { error: (result.stderr || '').trim() || `exit ${result.status}` };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: 'Circle CLI did not return JSON' };
  }
}

async function reportStatus() {
  const payer = existsSync(keyFile)
    ? privateKeyToAccount((await readFile(keyFile, 'utf8')).trim()).address
    : null;

  console.log('Local Gateway payer');
  console.log(`  self-managed EOA: ${payer ?? 'none (run: npm run gateway:wallet -- init)'}`);

  const cli = circleCli();
  if (!cli) {
    console.log('Circle CLI: not installed (set CIRCLE_CLI to enable official wallet checks)');
    return conclusion(payer, null);
  }

  const auth = readCircle(cli, ['wallet', 'status', '--output', 'json']);
  const session = auth?.data?.[gatewaySessionKey];
  console.log(`Circle CLI ${gatewaySessionKey} session: ${session?.tokenStatus ?? auth.error ?? 'unknown'}${session?.expiresIn ? ` (expires in ${session.expiresIn})` : ''}`);

  const wallets = readCircle(cli, ['wallet', 'list', '--chain', gatewayCircleChain, '--type', 'agent', '--output', 'json']);
  const agentWallet = wallets?.data?.wallets?.[0] ?? null;
  if (wallets.error) console.log(`  agent wallet: unavailable (${wallets.error})`);
  else if (!agentWallet) console.log(`  agent wallet: none on ${gatewayCircleChain}`);
  else console.log(`  agent wallet: ${agentWallet.address}`);

  const balance = agentWallet
    ? readCircle(cli, ['gateway', 'balance', '--address', agentWallet.address, '--chain', gatewayCircleChain, '--output', 'json'])
    : null;
  if (balance?.data) {
    console.log(`  Gateway balance: ${balance.data.total ?? '0'} ${balance.data.token ?? 'USDC'}`);
    console.log(`  backing EOA: ${balance.data.backingEOA ?? 'not reported'}`);
  } else if (balance?.error) {
    console.log(`  Gateway balance: unavailable (${balance.error})`);
  }

  return conclusion(payer, balance?.data?.backingEOA ?? null);
}

function conclusion(payer, backingEOA) {
  console.log('');
  console.log('GATEWAY_PAYER_ADDRESS must be an EOA: Gateway batch settlement is signed locally, not by the wallet API.');
  if (backingEOA && payer && backingEOA.toLowerCase() !== payer.toLowerCase()) {
    console.log(`The agent wallet is funded through backing EOA ${backingEOA}, which is not your local payer key.`);
    console.log(`Fund the payer instead of replacing it: circle gateway deposit --address <payer> --chain ${gatewayCircleChain} --method direct`);
  }
  console.log(`export GATEWAY_PAYER_ADDRESS=${payer ?? '<address from init>'}`);
}
