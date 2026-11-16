import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isAddress, parseAbiItem, type Address } from 'viem';
import { gatewayBalanceChain } from './gateway-balance-chain.js';
import { evidenceDigest, verifyBalanceEvidence } from './gateway-balance-evidence.js';
import { reconcileGatewayBalances, type BalanceSnapshot } from './reconcile-gateway-balances.js';
import { gatewayClient, gatewayNetworkConfig } from './gateway-x402.js';

// Public chain-only evidence. No database, private key or transaction-sending client.
export async function captureBalanceSample(payer: Address, from: bigint, to: bigint) {
  let snapshot: BalanceSnapshot | undefined;
  const result = await reconcileGatewayBalances(null, await gatewayBalanceChain('arcTestnet'), payer, from, to,
    async () => { throw new Error('Chain-only capture cannot query Gateway transfers'); },
    (input) => { snapshot = input; });
  if (!snapshot) throw new Error('Missing capture');
  return { version: 1, capturedAt: new Date().toISOString(), scope: 'public-chain-only',
    limitation: 'No local purchases or journal supplied. Journal differences are not proven business incidents.',
    snapshot, digest: evidenceDigest(snapshot), result };
}

async function discoverRecentDeposit() {
  const config = gatewayNetworkConfig('arcTestnet');
  const client = gatewayClient('arcTestnet', 2);
  if (await client.getChainId() !== config.chainConfig.id) throw new Error('RPC network mismatch');
  const head = (await client.getBlock({ blockTag: 'finalized' })).number;
  const event = parseAbiItem('event Deposited(address indexed token,address indexed depositor,address indexed sender,uint256 value)');
  // Explicitly bounded discovery: at most 2,000 finalized blocks, ten calls.
  for (let end = head; end > head - 2000n && end > 0n; end -= 200n) {
    await delay(1000);
    const logs = await client.getLogs({ address: config.domain.verifyingContract, event,
      args: { token: config.usdc }, fromBlock: end > 199n ? end - 199n : 1n, toBlock: end, strict: true });
    const latest = logs.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1).at(-1);
    if (latest) return { payer: latest.args.depositor, block: latest.blockNumber };
  }
  throw new Error('No deposit in the bounded window; supply a payer and explicit block range');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--replay' && args.length === 1) {
    const saved = JSON.parse(await readFile(args[0]!, 'utf8'));
    if (saved.version !== 1 || saved.scope !== 'public-chain-only' || saved.snapshot?.ledgerScope !== 'none' ||
        saved.snapshot?.network !== 'arcTestnet') throw new Error('Not a testnet chain-only sample');
    console.log(JSON.stringify(verifyBalanceEvidence('file-sample', saved), null, 2));
  } else {
    let payer: Address, from: bigint, to: bigint, output: string;
    if (mode === '--discover' && args.length === 1) {
      const found = await discoverRecentDeposit();
      payer = found.payer; from = found.block; to = found.block; output = args[0]!;
    } else if (mode && isAddress(mode) && args.length === 3 && /^\d+$/.test(args[0]!) && /^\d+$/.test(args[1]!)) {
      payer = mode; from = BigInt(args[0]!); to = BigInt(args[1]!); output = args[2]!;
    } else throw new Error('Usage: capture:gateway-balances -- --discover <new-file> | <payer> <from> <to> <new-file> | --replay <file>');
    const sample = await captureBalanceSample(payer, from, to);
    await writeFile(output, JSON.stringify(sample, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ output, payer, window: sample.result.window, digest: sample.digest,
      eventCount: Object.values(sample.snapshot.movements).reduce((sum, rows) => sum + rows.length, 0), status: sample.result.status }));
  }
}
