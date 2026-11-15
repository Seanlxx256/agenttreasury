import { isAddress } from 'viem';
import { arcTestnet } from 'viem/chains';

export const arcGatewayNetwork = `eip155:${arcTestnet.id}`;
export const gatewayTestnetApi = 'https://gateway-api-testnet.circle.com/v1/x402';
export const gatewayTracePrice = '1000';
export const gatewayDomain = {
  name: 'GatewayWalletBatched',
  version: '1',
  chainId: arcTestnet.id,
  verifyingContract: '0x0077777d7eba4688bdef3e311b846f25870a19b9',
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

// The testnet facilitator advertises a seven-day minimum.
export const gatewayValidity = 7 * 24 * 60 * 60 + 100;
export const requestIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export function traceOffer(endpoint: string, recipient: string) {
  return {
    x402Version: 2,
    resource: { url: endpoint, description: 'Sample transaction trace', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: arcGatewayNetwork,
      asset: '0x3600000000000000000000000000000000000000',
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
