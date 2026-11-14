import { createPublicClient, http, isAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { baseSepoliaUsdc } from './base-settlement.js';
import { marketPrice } from './merchant.js';

const { BASE_SEPOLIA_RPC_URL, PAYMENT_PAYER_KEY, PAYMENT_RELAYER_KEY, MERCHANT_RECIPIENT } = process.env;
const isKey = (value: string | undefined): value is `0x${string}` => /^0x[0-9a-fA-F]{64}$/.test(value ?? '');
if (!BASE_SEPOLIA_RPC_URL || !isKey(PAYMENT_PAYER_KEY) || !isKey(PAYMENT_RELAYER_KEY) ||
    !MERCHANT_RECIPIENT || !isAddress(MERCHANT_RECIPIENT)) {
  throw new Error('Set the Base Sepolia RPC, payer and relayer keys, and merchant recipient');
}
const payer = privateKeyToAccount(PAYMENT_PAYER_KEY).address;
const relayer = privateKeyToAccount(PAYMENT_RELAYER_KEY).address;
if (new Set([payer, relayer, MERCHANT_RECIPIENT].map((value) => value.toLowerCase())).size !== 3) {
  throw new Error('Use separate payer, relayer and merchant accounts');
}

const client = createPublicClient({ chain: baseSepolia,
  transport: http(BASE_SEPOLIA_RPC_URL, { timeout: 5000, retryCount: 0 }) });
try {
  if (await client.getChainId() !== baseSepolia.id) throw new Error('Incorrect RPC chain');
  const [head, usdc, gas] = await Promise.all([
    client.getBlock({ blockTag: 'finalized' }),
    client.readContract({ address: baseSepoliaUsdc,
      abi: parseAbi(['function balanceOf(address owner) view returns (uint256)']),
      functionName: 'balanceOf', args: [payer] }),
    client.getBalance({ address: relayer }),
  ]);
  const missingFunds = usdc < BigInt(marketPrice) || gas === 0n;
  console.log(JSON.stringify({ usableBalances: !missingFunds, payer, relayer, merchant: MERCHANT_RECIPIENT,
    finalizedBlock: String(head.number), payerUsdcBaseUnits: String(usdc), relayerEthWei: String(gas) }, null, 2));
  if (missingFunds) process.exitCode = 1;
} catch {
  console.error('Base Sepolia preflight failed. Check the RPC chain, connectivity, and finalized block support.');
  process.exitCode = 1;
}
