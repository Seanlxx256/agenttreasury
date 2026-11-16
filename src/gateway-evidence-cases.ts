import type { EvidenceSignal } from './gateway-evidence-extraction.js';

export type GatewayEvidenceCase = {
  name: string;
  text: string;
  expected: EvidenceSignal[];
  /** true when the text is a paraphrase that a keyword table is expected to miss. */
  paraphrased: boolean;
};

// Held-out free-text failure reasons. Roughly half are direct phrasings a
// keyword table catches; the other half are paraphrases that mean the same
// thing but do not contain the keyword, so a fixed table misses them. The
// expected signal is what a human reading the text would conclude.
export const gatewayEvidenceCases: GatewayEvidenceCase[] = [
  // Direct phrasings the rule baseline is expected to catch.
  { name: 'nonce already used', text: 'nonce already used for this wallet', expected: ['nonce-reused'], paraphrased: false },
  { name: 'insufficient funds', text: 'insufficient funds to cover the settlement', expected: ['insufficient-funds'], paraphrased: false },
  { name: 'recipient not whitelisted', text: 'recipient is not whitelisted for this domain', expected: ['recipient-not-whitelisted'], paraphrased: false },
  { name: 'signature verification failed', text: 'signature verification failed for the authorization', expected: ['invalid-signature'], paraphrased: false },
  { name: 'batch already processed', text: 'batch already processed on this contract', expected: ['batch-already-processed'], paraphrased: false },
  { name: 'authorization expired', text: 'authorization expired before submission', expected: ['authorization-expired'], paraphrased: false },
  { name: 'rpc timeout', text: 'RPC timeout while reading the contract balance', expected: ['rpc-unavailable'], paraphrased: false },
  { name: 'connection refused', text: 'connection refused by the gateway API', expected: ['rpc-unavailable'], paraphrased: false },
  { name: 'rate limited', text: 'rate limit exceeded, got 429', expected: ['rpc-unavailable'], paraphrased: false },
  { name: 'network error', text: 'network error talking to the node', expected: ['rpc-unavailable'], paraphrased: false },

  // Paraphrases the keyword table misses, but a reader recovers the same signal.
  { name: 'signed twice with the same identifier', text: 'the transfer was signed twice with the same identifier', expected: ['nonce-reused'], paraphrased: true },
  { name: 'wallet ran dry', text: 'the wallet ran dry before the batch settled', expected: ['insufficient-funds'], paraphrased: true },
  { name: 'destination not on the accepted list', text: 'the destination address is not on the accepted list', expected: ['recipient-not-whitelisted'], paraphrased: true },
  { name: 'authorization did not match the signing key', text: 'the authorization did not match the signing key', expected: ['invalid-signature'], paraphrased: true },
  { name: 'settlement booked earlier', text: 'this settlement was booked earlier under a different reference', expected: ['batch-already-processed'], paraphrased: true },
  { name: 'payment window closed', text: 'the payment window closed before it could be used', expected: ['authorization-expired'], paraphrased: true },
  { name: 'node did not respond', text: 'the node did not respond within the allowed time', expected: ['rpc-unavailable'], paraphrased: true },
  { name: 'gateway throttled requests', text: 'the gateway throttled our requests this minute', expected: ['rpc-unavailable'], paraphrased: true },
  { name: 'account cannot cover the transfer', text: 'the account cannot cover this transfer', expected: ['insufficient-funds'], paraphrased: true },
  { name: 'generic internal failure', text: 'generic internal processing failure', expected: ['unknown-error'], paraphrased: true },
];
