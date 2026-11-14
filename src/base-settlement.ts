import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, parseSignature, TransactionReceiptNotFoundError } from 'viem';
import type { Address, Hash, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export const baseSepoliaUsdc = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

const abi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signature: Hex;
  firstBlock: string;
}

export type Observation =
  | { status: 'settled'; hash: Hash }
  | { status: 'expired' | 'pending' | 'ready' };

export interface SettlementRail {
  head(): Promise<{ block: bigint; timestamp: bigint }>;
  sign(to: Address, value: string, validity: number, head: { block: bigint; timestamp: bigint }): Promise<Authorization>;
  observe(authorization: Authorization, submittedHash?: Hash): Promise<Observation>;
  submit(authorization: Authorization): Promise<Hash>;
}

export function createBaseSettlement(rpc: string, payerKey: Hex, relayerKey: Hex) {
  const payer = privateKeyToAccount(payerKey);
  const relayer = privateKeyToAccount(relayerKey);
  if (payer.address === relayer.address) throw new Error('Use separate payer and relayer keys');
  const chain = baseSepolia;
  const transport = http(rpc, { timeout: 5000, retryCount: 0 });
  const client = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account: relayer });

  const rail: SettlementRail = {
    async head() {
      const [head, finalized] = await Promise.all([
        client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockTag: 'finalized' }),
      ]);
      return { block: finalized.number + 1n, timestamp: head.timestamp };
    },
    async sign(to, value, validity, head) {
      const nonce = `0x${randomBytes(32).toString('hex')}` as const;
      const validAfter = head.timestamp > 5n ? head.timestamp - 5n : 0n;
      const validBefore = head.timestamp + BigInt(validity);
      const signature = await payer.signTypedData({
        domain: { name: 'USDC', version: '2', chainId: chain.id, verifyingContract: baseSepoliaUsdc },
        types: { TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ] },
        primaryType: 'TransferWithAuthorization',
        message: { from: payer.address, to, value: BigInt(value), validAfter, validBefore, nonce },
      });
      return { from: payer.address, to, value, validAfter: String(validAfter), validBefore: String(validBefore),
        nonce, signature, firstBlock: String(head.block) };
    },
    async observe(auth, submittedHash) {
      const matchesReceipt = (receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>) => {
        if (receipt.status !== 'success') return false;
        let used = false;
        let transferred = false;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== baseSepoliaUsdc) continue;
          try {
            const event = decodeEventLog({ abi, ...log });
            if (event.eventName === 'AuthorizationUsed' &&
                event.args.authorizer.toLowerCase() === auth.from.toLowerCase() && event.args.nonce === auth.nonce) used = true;
            if (event.eventName === 'Transfer' && event.args.from.toLowerCase() === auth.from.toLowerCase() &&
                event.args.to.toLowerCase() === auth.to.toLowerCase() && event.args.value === BigInt(auth.value)) transferred = true;
          } catch {
            // Ignore unrelated events.
          }
        }
        return used && transferred;
      };
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      if (submittedHash) {
        try {
          const receipt = await client.getTransactionReceipt({ hash: submittedHash });
          if (matchesReceipt(receipt)) {
            if (receipt.blockNumber > finalized.number) return { status: 'pending' };
            const block = await client.getBlock({ blockNumber: receipt.blockNumber });
            if (block.hash === receipt.blockHash) return { status: 'settled', hash: submittedHash };
          }
        } catch (error) {
          if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        }
      }
      const first = BigInt(auth.firstBlock);
      const args = { address: baseSepoliaUsdc as Address, abi, functionName: 'authorizationState' as const,
        args: [auth.from, auth.nonce] as const };
      if (finalized.number >= first &&
          await client.readContract({ ...args, blockNumber: finalized.number })) {
        // Scan the validity window, allowing chunked provider log queries.
        for (let start = first; start <= finalized.number; start += 500n) {
          const end = start + 499n < finalized.number ? start + 499n : finalized.number;
          const events = await client.getContractEvents({ address: baseSepoliaUsdc, abi,
            eventName: 'AuthorizationUsed', args: { authorizer: auth.from, nonce: auth.nonce },
            fromBlock: start, toBlock: end, strict: true });
          for (const event of events) {
            if (!event.transactionHash) continue;
            const receipt = await client.getTransactionReceipt({ hash: event.transactionHash });
            if (receipt.blockHash === event.blockHash && matchesReceipt(receipt)) {
              return { status: 'settled', hash: event.transactionHash };
            }
          }
          if ((await client.getBlock({ blockNumber: end })).timestamp >= BigInt(auth.validBefore)) break;
        }
        // A consumed nonce without matching transfer evidence requires investigation.
        return { status: 'pending' };
      }
      if (finalized.timestamp >= BigInt(auth.validBefore) && finalized.number >= first) {
        return { status: 'expired' };
      }
      const latest = await client.getBlock({ blockTag: 'latest' });
      if (latest.timestamp >= BigInt(auth.validBefore) || latest.timestamp <= BigInt(auth.validAfter) ||
          await client.readContract({ ...args, blockNumber: latest.number })) return { status: 'pending' };
      return { status: 'ready' };
    },
    async submit(auth) {
      const { r, s, yParity } = parseSignature(auth.signature);
      const { request } = await client.simulateContract({
        address: baseSepoliaUsdc, abi, functionName: 'transferWithAuthorization', account: relayer,
        args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore),
          auth.nonce, yParity + 27, r, s],
      });
      return wallet.writeContract(request);
    },
  };
  return { rail, getChainId: () => client.getChainId() };
}
