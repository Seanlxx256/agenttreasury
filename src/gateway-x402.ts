import { createPublicClient, http, isAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client';

// Arc network selection. Testnet by default; set GATEWAY_NETWORK=arc for mainnet.
// The single-environment configuration below is kept for backward compatibility,
// while `gatewayNetworkConfig` provides a per-network factory so a purchase,
// reconciliation pass, or refund can target several networks in one process.
export type GatewayNetworkName = 'arc' | 'arcTestnet';

function resolveNetwork(name?: string): GatewayNetworkName {
  return name === 'arc' ? 'arc' : 'arcTestnet';
}

export interface GatewayNetworkConfig {
  /** eip155 chain id, e.g. eip155:5042 */
  network: string;
  chainName: GatewayNetworkName;
  chainConfig: (typeof CHAIN_CONFIGS)[GatewayNetworkName]['chain'];
  rpcUrl: string;
  usdc: Address;
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  /** CCTP-style domain id used in Gateway batch calldata. */
  domainId: number;
  api: string;
  circleChain: 'ARC' | 'ARC-TESTNET';
  sessionKey: 'mainnet' | 'testnet';
}

// Per-network factory: every network-specific value (chain, RPC, USDC, Gateway
// contract, REST API, Circle CLI name) is derived from the official SDK config
// for that network, so callers never hardcode a single chain again.
export function gatewayNetworkConfig(name: GatewayNetworkName, apiOverride?: string): GatewayNetworkConfig {
  const chain = resolveNetwork(name);
  const config = CHAIN_CONFIGS[chain];
  const isMainnet = chain === 'arc';
  const api = apiOverride ?? (isMainnet
    ? 'https://gateway-api.circle.com/v1/x402'
    : 'https://gateway-api-testnet.circle.com/v1/x402');
  return {
    network: `eip155:${config.chain.id}`,
    chainName: chain,
    chainConfig: config.chain,
    rpcUrl: config.rpcUrl!,
    usdc: config.tokens.USDC!.address as Address,
    domain: {
      name: 'GatewayWalletBatched',
      version: '1',
      chainId: config.chain.id,
      verifyingContract: config.gatewayWallet as Address,
    },
    domainId: config.domain,
    api,
    circleChain: isMainnet ? 'ARC' : 'ARC-TESTNET',
    sessionKey: isMainnet ? 'mainnet' : 'testnet',
  };
}

// Backward-compatible singleton for the process default network. Downstream
// modules that only ever touch one network keep importing these; multi-network
// call paths should use `gatewayNetworkConfig` instead.
const defaultNetwork = resolveNetwork(process.env.GATEWAY_NETWORK);
const defaultConfig = gatewayNetworkConfig(defaultNetwork, process.env.GATEWAY_API);

export const gatewayChainName = defaultConfig.chainName;
export const gatewayChainConfig = defaultConfig.chainConfig;
export const gatewayRpcUrl = defaultConfig.rpcUrl;
// Circle CLI names the same network differently from the SDK: ARC vs ARC-TESTNET.
export const gatewayCircleChain = defaultConfig.circleChain;
// The Circle CLI session stores mainnet and testnet in separate slots.
export const gatewaySessionKey = defaultConfig.sessionKey;

export const arcGatewayNetwork = defaultConfig.network;
export const gatewayApi = defaultConfig.api;
export const gatewayTracePrice = '1000';
export const arcTestnetUsdc = defaultConfig.usdc;
export const gatewayDomain = defaultConfig.domain;
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

export function recoverGatewayPayer(
  authorization: GatewayAuthorization,
  signature: Hex,
  network: GatewayNetworkName = defaultNetwork,
) {
  const config = gatewayNetworkConfig(network);
  return recoverTypedDataAddress({
    domain: config.domain, types: gatewayAuthorizationTypes, primaryType: 'TransferWithAuthorization',
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

export function gatewayClient(network: GatewayNetworkName = defaultNetwork, retryCount = 0) {
  const config = gatewayNetworkConfig(network);
  const rpcUrl = network === 'arcTestnet' ? (process.env.ARC_TESTNET_RPC_URL ?? config.rpcUrl) : config.rpcUrl;
  return createPublicClient({
    chain: config.chainConfig,
    transport: http(rpcUrl, { timeout: 5000, retryCount }),
  });
}

// Backward-compatible alias for the testnet-only client.
export function arcTestnetClient(retryCount = 0) {
  return gatewayClient('arcTestnet', retryCount);
}

export function traceOffer(
  endpoint: string,
  recipient: string,
  network: GatewayNetworkName = defaultNetwork,
) {
  const config = gatewayNetworkConfig(network);
  return {
    x402Version: 2,
    resource: { url: endpoint, description: 'Sample transaction trace', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: config.network,
      asset: config.usdc,
      amount: gatewayTracePrice,
      payTo: recipient.toLowerCase(),
      maxTimeoutSeconds: gatewayValidity,
      extra: {
        name: config.domain.name,
        version: config.domain.version,
        verifyingContract: config.domain.verifyingContract,
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
