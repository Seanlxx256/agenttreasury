import type { PatternCase, SystemicPattern } from './gateway-patterns.js';

export type GatewayPatternBatch = {
  name: string;
  cases: PatternCase[];
  expected: SystemicPattern;
};

// Six batches of three failures each, from one supplier or network. Three use
// direct keyword phrasings the rule baseline can count; three use paraphrases
// that mean the same systemic cause without the keyword, so only a reader (or a
// model reading the texts together) recovers the shared pattern. One mixed batch
// has no shared cause.
export const gatewayPatternBatches: GatewayPatternBatch[] = [
  {
    name: 'supplier nonce reuse, direct',
    cases: [
      { text: 'nonce already used for this wallet', dimension: 'supplier-a' },
      { text: 'nonce already consumed by a prior transfer', dimension: 'supplier-a' },
      { text: 'nonce reused across two transfers', dimension: 'supplier-a' },
    ],
    expected: 'supplier-nonce-bug',
  },
  {
    name: 'supplier nonce reuse, paraphrased',
    cases: [
      { text: 'the transfer was signed twice with the same identifier', dimension: 'supplier-a' },
      { text: 'the same authorization id was submitted again', dimension: 'supplier-a' },
      { text: 'this transfer was replayed under the same signature', dimension: 'supplier-a' },
    ],
    expected: 'supplier-nonce-bug',
  },
  {
    name: 'wallet funding gap, direct',
    cases: [
      { text: 'insufficient funds to settle', dimension: 'supplier-b' },
      { text: 'not enough balance for the transfer', dimension: 'supplier-b' },
      { text: 'out of funds on the wallet', dimension: 'supplier-b' },
    ],
    expected: 'wallet-funding-gap',
  },
  {
    name: 'wallet funding gap, paraphrased',
    cases: [
      { text: 'the wallet ran dry before settlement', dimension: 'supplier-b' },
      { text: 'the account cannot cover this transfer', dimension: 'supplier-b' },
      { text: 'the balance emptied before the batch', dimension: 'supplier-b' },
    ],
    expected: 'wallet-funding-gap',
  },
  {
    name: 'network rpc outage, direct',
    cases: [
      { text: 'RPC timeout on the node', dimension: 'network-arc' },
      { text: 'connection refused by the gateway', dimension: 'network-arc' },
      { text: 'network error reading balance', dimension: 'network-arc' },
    ],
    expected: 'rpc-outage',
  },
  {
    name: 'unrelated failures, no shared cause',
    cases: [
      { text: 'nonce already used for this wallet', dimension: 'supplier-a' },
      { text: 'insufficient funds to settle', dimension: 'supplier-b' },
      { text: 'signature verification failed', dimension: 'supplier-c' },
    ],
    expected: 'no-systemic-pattern',
  },
];
