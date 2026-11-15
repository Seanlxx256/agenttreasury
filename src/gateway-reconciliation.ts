import { arcGatewayNetwork as network, gatewayTestnetApi } from './gateway-x402.js';

const endpoint = `${gatewayTestnetApi}/transfers`;

export interface ExpectedGatewayPayment {
  nonce: string;
  payer: string;
  recipient: string;
  amountUnits: string;
}

type TransferEvidence = { id: string; txHash: string | null };
type GatewayPage = { transfers?: unknown; pagination?: { pageAfter?: unknown } };

export type GatewayObservation =
  | { status: 'unknown' }
  | ({ status: 'pending' | 'failed' } & TransferEvidence)
  | { status: 'charged'; id: string; txHash: string }
  | { status: 'conflict'; reason: 'multiple-transfers' | 'transfer-mismatch' };

export async function observeGatewayPayment(
  expected: ExpectedGatewayPayment,
  request: typeof fetch = fetch,
): Promise<GatewayObservation> {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ nonce: expected.nonce, network, pageSize: '2' }).toString();
  const response = await request(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error(`Gateway transfer lookup returned HTTP ${response.status}`);

  const page: GatewayPage | null = await response.json();
  if (!Array.isArray(page?.transfers)) throw new Error('Invalid Gateway transfer search response');
  if (page.transfers.length > 1 || page.pagination?.pageAfter) {
    return { status: 'conflict', reason: 'multiple-transfers' };
  }
  if (page.transfers.length === 0) return { status: 'unknown' };

  const transfer: Record<string, unknown> | null = page.transfers[0];
  if (typeof transfer?.id !== 'string' || !transfer.id ||
      !(transfer.txHash === null || typeof transfer.txHash === 'string')) {
    throw new Error('Invalid Gateway transfer evidence');
  }
  if (!matchesHex(transfer.nonce, expected.nonce) ||
      !matchesHex(transfer.fromAddress, expected.payer) ||
      !matchesHex(transfer.toAddress, expected.recipient) ||
      transfer.token !== 'USDC' || transfer.sendingNetwork !== network ||
      transfer.recipientNetwork !== network || transfer.amount !== expected.amountUnits) {
    return { status: 'conflict', reason: 'transfer-mismatch' };
  }

  const evidence = { id: transfer.id, txHash: transfer.txHash };
  switch (transfer.status) {
    case 'received':
    case 'batched':
      return { status: 'pending', ...evidence };
    case 'confirmed':
    case 'completed':
      if (!transfer.txHash || !/^0x[\da-f]{64}$/i.test(transfer.txHash)) {
        throw new Error('Confirmed Gateway transfer is missing a valid batch hash');
      }
      return { status: 'charged', id: transfer.id, txHash: transfer.txHash.toLowerCase() };
    case 'failed':
      return { status: 'failed', ...evidence };
    default:
      throw new Error('Unrecognized Gateway transfer status');
  }
}

function matchesHex(observed: unknown, expected: string): boolean {
  return typeof observed === 'string' && observed.toLowerCase() === expected.toLowerCase();
}
