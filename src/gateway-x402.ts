import { createPublicClient, http, isAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client';

// Arc network selection. Testnet by default; set GATEWAY_NETWORK=arc for mainnet.
// Chain ID, USDC address, and Gateway contract come from Circle's official SDK config.
const gatewayChain = (process.env.GATEWAY_NETWORK === 'arc' ? 'arc' : 'arcTestnet') as 'arc' | 'arcTestnet';
const gatewayConfig = CHAIN_CONFIGS[gatewayChain];

export const arcGatewayNetwork = `eip155:${gatewayConfig.chain.id}`;
// Gateway REST API. Selected by network; override with GATEWAY_API if needed.
const gatewayApiBase = process.env.GATEWAY_API
  ?? (gatewayChain === 'arc' ? 'https://gateway-api.circle.com/v1/x402' : 'https://gateway-api-testnet.circle.com/v1/x402');
export const gatewayApi = gatewayApiBase;
export const gatewayTracePrice = '1000';
export const arcTestnetUsdc = gatewayConfig.tokens.USDC!.address as Address;
export const gatewayDomain = {
  name: 'GatewayWalletBatched',
  version: '1',
  chainId: gatewayConfig.chain.id,
  verifyingContract: gatewayConfig.gatewayWallet as Address,
} as const;
export const gatewayAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export type GatewayAuthorization = {
  from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex;
};

export function recoverGatewayPayer(authorization: GatewayAuthorization, signature: Hex) {
  return recoverTypedDataAddress({
    domain: gatewayDomain, types: gatewayAuthorizationTypes, primaryType: 'TransferWithAuthorization',
    message: {
      ...authorization, value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore),
    },
    signature,
  });
}

// The testnet facilitator advertises a seven-day minimum.
export const gatewayValidity = 7 * 24 * 60 * 60 + 100;
export const requestIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export function arcTestnetClient(retryCount = 0) {
  return createPublicClient({
    chain: gatewayConfig.chain,
    transport: http(process.env.ARC_TESTNET_RPC_URL ?? gatewayConfig.rpcUrl, {
      timeout: 5000, retryCount,
    }),
  });
}

export function traceOffer(endpoint: string, recipient: string) {
  return {
    x402Version: 2,
    resource: { url: endpoint, description: 'Sample transaction trace', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: arcGatewayNetwork,
      asset: arcTestnetUsdc,
      amount: gatewayTracePrice,
      payTo: recipient.toLowerCase(),
      maxTimeoutSeconds: gatewayValidity,
      extra: {
        name: gatewayDomain.name,
        version: gatewayDomain.version,
        verifyingContract: gatewayDomain.verifyingContract,
      },
    }],
  } as const;
}

export function encodePaymentHeader(data: unknown): string {
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

export function decodePaymentHeader(header: string | null) {
  if (!header || header.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) {
    throw new Error('Invalid x402 header');
  }
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

export function gatewayDemoConfig() {
  const port = Number(process.env.GATEWAY_MERCHANT_PORT ?? 3002);
  const recipient = process.env.GATEWAY_MERCHANT_RECIPIENT;
  if (!recipient || !isAddress(recipient) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Set GATEWAY_MERCHANT_RECIPIENT and optionally GATEWAY_MERCHANT_PORT');
  }
  return { recipient, port, origin: `http://127.0.0.1:${port}` };
}
