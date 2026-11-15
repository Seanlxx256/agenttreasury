import { decodeAbiParameters, decodeFunctionData, parseAbi, parseAbiItem, parseAbiParameters,
  TransactionReceiptNotFoundError, type Address, type Hash } from 'viem';
import { arcTestnetClient, arcTestnetUsdc as token, gatewayChainConfig, gatewayDomain } from './gateway-x402.js';

const address = gatewayDomain.verifyingContract;
const balance = parseAbi(['function totalBalance(address token, address depositor) view returns (uint256)']);
const batchCall = parseAbi(['function submitBatch(bytes calldataBytes, bytes signature)']);
const batchFormat = parseAbiParameters('(address depositor, int256 value)[] deltas, bytes32 batchId, uint32 domain, address token, address wallet');
const batchEvent = parseAbiItem('event BatchProcessed(bytes32 indexed batchId, address indexed signer, address indexed tokenAddress)');
const depositEvent = parseAbiItem('event Deposited(address indexed token, address indexed depositor, address indexed sender, uint256 value)');
const withdrawalEvent = parseAbiItem('event WithdrawalCompleted(address indexed token, address indexed depositor, uint256 value)');
const burnEvent = parseAbiItem('event GatewayBurned(address indexed token, address indexed depositor, bytes32 indexed transferSpecHash, uint32 destinationDomain, bytes32 destinationRecipient, address signer, uint256 value, uint256 fee, uint256 fromAvailable, uint256 fromWithdrawing)');
const arcDomain = 26;

type Movement = { hash: Hash; logIndex: number; amount: bigint };
type Batch = { hash: Hash; id: Hash; delta: bigint };

export interface GatewayBalanceChain {
  finalized(): Promise<bigint>;
  blockHash(block: bigint): Promise<Hash>;
  totalBalance(wallet: Address, block: bigint): Promise<bigint>;
  receiptBlock(hash: Hash): Promise<bigint | null>;
  movements(wallet: Address, from: bigint, to: bigint): Promise<{
    deposits: Movement[]; withdrawals: Movement[]; burns: Movement[]; batches: Batch[];
  }>;
}

export async function gatewayBalanceChain(): Promise<GatewayBalanceChain> {
  const client = arcTestnetClient(4);
  if (await client.getChainId() !== gatewayChainConfig.id) throw new Error('RPC endpoint must serve the selected Arc network');
  return {
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
      const result: Awaited<ReturnType<GatewayBalanceChain['movements']>> = {
        deposits: [], withdrawals: [], burns: [], batches: [],
      };
      const seen = new Set<string>();
      for (let fromBlock = from; fromBlock <= to; fromBlock += 200n) {
        const pageEnd = fromBlock + 199n;
        const range = { address, fromBlock, toBlock: pageEnd < to ? pageEnd : to, strict: true } as const;
        const args = { token, depositor: wallet } as const;
        const deposits = await client.getLogs({ ...range, event: depositEvent, args });
        const withdrawals = await client.getLogs({ ...range, event: withdrawalEvent, args });
        const burns = await client.getLogs({ ...range, event: burnEvent, args });
        const batches = await client.getLogs({ ...range, event: batchEvent, args: { tokenAddress: token } });
        const add = (target: Movement[], log: { transactionHash: Hash; logIndex: number }, amount: bigint) => {
          const key = `${log.transactionHash}:${log.logIndex}`;
          if (seen.has(key)) return;
          seen.add(key);
          target.push({ hash: log.transactionHash, logIndex: log.logIndex, amount });
        };
        for (const log of deposits) add(result.deposits, log, log.args.value);
        for (const log of withdrawals) add(result.withdrawals, log, log.args.value);
        for (const log of burns) add(result.burns, log, log.args.fromAvailable + log.args.fromWithdrawing);

        for (const log of batches) {
          const key = `${log.transactionHash}:${log.logIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const tx = await client.getTransaction({ hash: log.transactionHash });
          if (tx.to?.toLowerCase() !== address || tx.blockHash !== log.blockHash) {
            throw new Error(`Cannot locate direct Gateway batch call for ${log.transactionHash}`);
          }
          const { args: [data] } = decodeFunctionData({ abi: batchCall, data: tx.input });
          const [deltas, id, domain, asset, contract] = decodeAbiParameters(batchFormat, data);
          if (id !== log.args.batchId || domain !== arcDomain || asset.toLowerCase() !== token ||
              contract.toLowerCase() !== address || deltas.reduce((sum, entry) => sum + entry.value, 0n) !== 0n) {
            throw new Error(`Invalid Gateway batch calldata for ${log.transactionHash}`);
          }
          const entries = deltas.filter((entry) => entry.depositor.toLowerCase() === wallet);
          if (entries.length) result.batches.push({ hash: log.transactionHash, id,
            delta: entries.reduce((sum, entry) => sum + entry.value, 0n) });
        }
      }
      return result;
    },
  };
}
