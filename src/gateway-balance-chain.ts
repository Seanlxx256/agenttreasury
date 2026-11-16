import { createHash } from 'node:crypto';
import { decodeAbiParameters, decodeFunctionData, parseAbi, parseAbiItem, parseAbiParameters,
  TransactionReceiptNotFoundError, type Address, type Hash } from 'viem';
import { gatewayChainName, gatewayClient, gatewayNetworkConfig, type GatewayNetworkName } from './gateway-x402.js';

const balance = parseAbi(['function totalBalance(address token, address depositor) view returns (uint256)']);
const batchCall = parseAbi(['function submitBatch(bytes calldataBytes, bytes signature)']);
const batchFormat = parseAbiParameters('(address depositor, int256 value)[] deltas, bytes32 batchId, uint32 domain, address token, address wallet');
const batchEvent = parseAbiItem('event BatchProcessed(bytes32 indexed batchId, address indexed signer, address indexed tokenAddress)');
const depositEvent = parseAbiItem('event Deposited(address indexed token, address indexed depositor, address indexed sender, uint256 value)');
const withdrawalEvent = parseAbiItem('event WithdrawalCompleted(address indexed token, address indexed depositor, uint256 value)');
const burnEvent = parseAbiItem('event GatewayBurned(address indexed token, address indexed depositor, bytes32 indexed transferSpecHash, uint32 destinationDomain, bytes32 destinationRecipient, address signer, uint256 value, uint256 fee, uint256 fromAvailable, uint256 fromWithdrawing)');

export type ChainLogEvidence = {
  blockNumber: string; blockHash: Hash; address: Address; topics: readonly Hash[]; data: Hash;
  transactionInput?: Hash;
};
type Movement = { hash: Hash; logIndex: number; amount: bigint; evidence?: ChainLogEvidence };
type Batch = { hash: Hash; id: Hash; delta: bigint; logIndex?: number; evidence?: ChainLogEvidence };

export interface GatewayBalanceChain {
  network: GatewayNetworkName;
  source?: { kind: 'rpc' | 'fixture'; chainId: number; endpointFingerprint?: string };
  finalized(): Promise<bigint>;
  blockHash(block: bigint): Promise<Hash>;
  totalBalance(wallet: Address, block: bigint): Promise<bigint>;
  receiptBlock(hash: Hash): Promise<bigint | null>;
  movements(wallet: Address, from: bigint, to: bigint): Promise<{
    deposits: Movement[]; withdrawals: Movement[]; burns: Movement[]; batches: Batch[];
  }>;
}

export async function gatewayBalanceChain(network: GatewayNetworkName = gatewayChainName,
  client = gatewayClient(network, 4)): Promise<GatewayBalanceChain> {
  const config = gatewayNetworkConfig(network);
  const address = config.domain.verifyingContract.toLowerCase() as Address;
  const token = config.usdc.toLowerCase() as Address;
  const domainId = config.domainId;
  if (await client.getChainId() !== config.chainConfig.id) throw new Error('RPC endpoint must serve the selected Arc network');
  return {
    network,
    source: { kind: 'rpc', chainId: config.chainConfig.id,
      endpointFingerprint: createHash('sha256').update(network === 'arcTestnet'
        ? (process.env.ARC_TESTNET_RPC_URL ?? config.rpcUrl) : config.rpcUrl).digest('hex') },
    async finalized() {
      return (await client.getBlock({ blockTag: 'finalized' })).number;
    },
    async blockHash(blockNumber) {
      return (await client.getBlock({ blockNumber })).hash;
    },
    totalBalance(wallet, blockNumber) {
      return client.readContract({ address, abi: balance, functionName: 'totalBalance', args: [token, wallet], blockNumber });
    },
    async receiptBlock(hash) {
      try {
        return (await client.getTransactionReceipt({ hash })).blockNumber;
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    async movements(wallet, from, to) {
      wallet = wallet.toLowerCase() as Address;
      const result: Awaited<ReturnType<GatewayBalanceChain['movements']>> = {
        deposits: [], withdrawals: [], burns: [], batches: [],
      };
      const seen = new Map<string, string>();
      const duplicate = (log: { transactionHash: Hash; logIndex: number; blockNumber: bigint; blockHash: Hash; address: Address; topics: readonly Hash[]; data: Hash }) => {
        const key = `${log.transactionHash}:${log.logIndex}`;
        const value = JSON.stringify(logEvidence(log));
        if (seen.has(key)) {
          if (seen.get(key) !== value) throw new Error('Conflicting duplicate RPC log');
          return true;
        }
        seen.set(key, value);
        return false;
      };
      for (let fromBlock = from; fromBlock <= to; fromBlock += 200n) {
        const pageEnd = fromBlock + 199n;
        const range = { address, fromBlock, toBlock: pageEnd < to ? pageEnd : to, strict: true } as const;
        const args = { token, depositor: wallet } as const;
        const deposits = await client.getLogs({ ...range, event: depositEvent, args });
        const withdrawals = await client.getLogs({ ...range, event: withdrawalEvent, args });
        const burns = await client.getLogs({ ...range, event: burnEvent, args });
        const batches = await client.getLogs({ ...range, event: batchEvent, args: { tokenAddress: token } });
        const add = (target: Movement[], log: { transactionHash: Hash; logIndex: number; blockNumber: bigint; blockHash: Hash; address: Address; topics: readonly Hash[]; data: Hash }, amount: bigint) => {
          if (duplicate(log)) return;
          target.push({ hash: log.transactionHash, logIndex: log.logIndex, amount, evidence: logEvidence(log) });
        };
        for (const log of deposits) add(result.deposits, log, log.args.value);
        for (const log of withdrawals) add(result.withdrawals, log, log.args.value);
        for (const log of burns) add(result.burns, log, log.args.fromAvailable + log.args.fromWithdrawing);

        for (const log of batches) {
          if (duplicate(log)) continue;
          const tx = await client.getTransaction({ hash: log.transactionHash });
          if (tx.to?.toLowerCase() !== address || tx.blockHash !== log.blockHash) {
            throw new Error(`Cannot locate direct Gateway batch call for ${log.transactionHash}`);
          }
          const { args: [data] } = decodeFunctionData({ abi: batchCall, data: tx.input });
          const [deltas, id, domain, asset, contract] = decodeAbiParameters(batchFormat, data);
          if (id !== log.args.batchId || domain !== domainId || asset.toLowerCase() !== token ||
              contract.toLowerCase() !== address || deltas.reduce((sum, entry) => sum + entry.value, 0n) !== 0n) {
            throw new Error(`Invalid Gateway batch calldata for ${log.transactionHash}`);
          }
          const entries = deltas.filter((entry) => entry.depositor.toLowerCase() === wallet);
          if (entries.length) result.batches.push({ hash: log.transactionHash, id, logIndex: log.logIndex,
            evidence: { ...logEvidence(log), transactionInput: tx.input },
            delta: entries.reduce((sum, entry) => sum + entry.value, 0n) });
        }
      }
      return result;
    },
  };
}

function logEvidence(log: { blockNumber: bigint; blockHash: Hash; address: Address; topics: readonly Hash[]; data: Hash }): ChainLogEvidence {
  return { blockNumber: String(log.blockNumber), blockHash: log.blockHash, address: log.address.toLowerCase() as Address,
    topics: log.topics, data: log.data };
}
