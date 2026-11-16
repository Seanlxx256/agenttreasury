import { decodeAbiParameters, decodeEventLog, decodeFunctionData, parseAbi, parseAbiItem, parseAbiParameters,
  type Hash, type Hex } from 'viem';
import { gatewayNetworkConfig, type GatewayNetworkName } from './gateway-x402.js';
import type { BalanceSnapshot } from './reconcile-gateway-balances.js';

const call = parseAbi(['function submitBatch(bytes calldataBytes,bytes signature)']);
const format = parseAbiParameters('(address depositor,int256 value)[] deltas,bytes32 batchId,uint32 domain,address token,address wallet');
export const gatewayBatchEvent = parseAbiItem('event BatchProcessed(bytes32 indexed batchId,address indexed signer,address indexed tokenAddress)');

export function decodeGatewayBatch(input: Hex, expectedId: Hash, network: GatewayNetworkName) {
  const config = gatewayNetworkConfig(network);
  const { args: [data] } = decodeFunctionData({ abi: call, data: input });
  const [deltas, id, domain, token, wallet] = decodeAbiParameters(format, data);
  if (id.toLowerCase() !== expectedId.toLowerCase() || domain !== config.domainId ||
      token.toLowerCase() !== config.usdc.toLowerCase() ||
      wallet.toLowerCase() !== config.domain.verifyingContract.toLowerCase() ||
      deltas.reduce((sum, row) => sum + row.value, 0n) !== 0n) {
    throw new Error('Invalid Gateway batch calldata');
  }
  return { id, deltas };
}

// Re-decode saved raw logs/calldata, rather than trusting the saved normalized delta.
// This validates internal evidence consistency, not a receipt inclusion proof.
export function validateRecordedBatches(snapshot: BalanceSnapshot) {
  return snapshot.movements.batches.map((batch) => {
    const log = batch.evidence;
    if (!log?.transactionInput) return { hash: batch.hash, status: 'unavailable' as const,
      reason: 'Raw batch log and calldata are unavailable.' };
    const config = gatewayNetworkConfig(snapshot.network);
    if (log.address.toLowerCase() !== config.domain.verifyingContract.toLowerCase() ||
        BigInt(log.blockNumber) < BigInt(snapshot.from) || BigInt(log.blockNumber) > BigInt(snapshot.to)) {
      throw new Error('Batch event provenance mismatch');
    }
    const event = decodeEventLog({ abi: [gatewayBatchEvent], topics: [...log.topics] as [Hash, ...Hash[]], data: log.data });
    if (event.args.batchId.toLowerCase() !== batch.id.toLowerCase() ||
        event.args.tokenAddress.toLowerCase() !== config.usdc.toLowerCase()) throw new Error('Batch event terms mismatch');
    const decoded = decodeGatewayBatch(log.transactionInput, batch.id, snapshot.network);
    const entries = decoded.deltas.filter((row) => row.depositor.toLowerCase() === snapshot.payer.toLowerCase());
    const delta = entries.reduce((sum, row) => sum + row.value, 0n);
    if (!entries.length || delta !== BigInt(batch.delta)) throw new Error('Saved wallet delta differs from raw batch calldata');
    return { hash: batch.hash, status: 'verified' as const, batchId: batch.id, walletDelta: String(delta),
      participantEntries: decoded.deltas.length, logIndex: batch.logIndex,
      limitation: 'Batch calldata contains net wallet deltas, not individual payment nonces or authorization inclusion proofs.' };
  });
}
