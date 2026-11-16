import type { EvidenceSignal } from './gateway-evidence-extraction.js';

export type GatewayEvidenceTest = { name: string; text: string; expected: EvidenceSignal[]; paraphrased: false };

// Frozen held-out test set for the unstructured evidence extraction task.
// These strings are authored from the same failure taxonomy as the development
// set (`gateway-evidence-v1`) but use new wording and were never used to tune
// the prompt or the keyword table. They are measured only after the
// implementation is frozen. The `paraphrased` flag is always false here: the
// development set uses it to expose the keyword table's blind spot, but the
// frozen set deliberately does not partition on it — it mixes direct and
// reworded phrasings naturally.
export const gatewayEvidenceTestCases: GatewayEvidenceTest[] = [
  { name: 'nonce already used for this authorization', text: 'nonce already used for this authorization', expected: ['nonce-reused'], paraphrased: false },
  { name: 'insufficient funds in the gateway wallet', text: 'insufficient funds in the gateway wallet', expected: ['insufficient-funds'], paraphrased: false },
  { name: 'recipient not whitelisted for this network', text: 'recipient not whitelisted for this network', expected: ['recipient-not-whitelisted'], paraphrased: false },
  { name: 'signature verification failed on the authorization', text: 'signature verification failed on the authorization', expected: ['invalid-signature'], paraphrased: false },
  { name: 'batch already settled on this contract', text: 'batch already settled on this contract', expected: ['batch-already-processed'], paraphrased: false },
  { name: 'authorization identifier submitted a second time', text: 'the authorization identifier was submitted a second time', expected: ['nonce-reused'], paraphrased: false },
  { name: 'wallet balance cannot cover this settlement', text: 'the wallet balance cannot cover this settlement', expected: ['insufficient-funds'], paraphrased: false },
  { name: 'destination missing from the accepted list', text: 'this destination is missing from the accepted list', expected: ['recipient-not-whitelisted'], paraphrased: false },
  { name: 'node never answered before the deadline', text: 'the node never answered before the deadline', expected: ['rpc-unavailable'], paraphrased: false },
  { name: 'internal condition the system could not classify', text: 'an internal condition the system could not classify', expected: ['unknown-error'], paraphrased: false },
];
