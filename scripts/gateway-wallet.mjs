import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createWalletClient, erc20Abi, http, parseAbi, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';
import { arcTestnetClient, arcTestnetUsdc, gatewayDomain } from '../dist/src/gateway-x402.js';

const [mode, amount] = process.argv.slice(2);
if (process.argv.length > 4 || !(mode === 'init' && amount === undefined) &&
    !(mode === 'deposit' && /^\d+(?:\.\d{1,6})?$/.test(amount ?? ''))) {
  throw new Error('Usage: npm run gateway:wallet -- init | deposit <test-usdc>');
}

const directory = new URL('../.gateway-local/', import.meta.url);
const keyFile = new URL('payer-key', directory);
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
  console.log(`Arc testnet payer: ${account.address}`);
  console.log(`Signing key file: ${fileURLToPath(keyFile)}`);
} else {
  const value = parseUnits(amount, 6);
  if (value <= 0n) throw new Error('Deposit amount must be positive');
  const chain = arcTestnetClient();
  if (await chain.getChainId() !== arcTestnet.id) throw new Error('RPC endpoint must serve Arc Testnet');
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(process.env.ARC_TESTNET_RPC_URL, {
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
