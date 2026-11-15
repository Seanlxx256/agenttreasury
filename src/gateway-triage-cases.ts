import type { prepareGatewayTriage, TriageAction, TriageObservation } from './gateway-triage.js';

type Purchase = Parameters<typeof prepareGatewayTriage>[0];

export type GatewayTriageCase = {
  name: string;
  purchase: Purchase;
  observations: TriageObservation[];
  expectedAction: TriageAction;
  requiredCitations: string[];
  optionalCitations?: string[];
};

const unresolved: Purchase = {
  budgetStatus: 'reserved', reviewRequired: false, buyerHasDelivery: false,
  sellerHasDelivery: false, journal: null,
};
const settled: Purchase = { ...unresolved, budgetStatus: 'spent', journal: true };

export const gatewayTriageCases: GatewayTriageCase[] = [
  {
    name: 'No lookup has run',
    purchase: unresolved, observations: [],
    expectedAction: 'check-gateway', requiredCitations: ['budget'],
  },
  {
    name: 'Submission timed out and nonce lookup is empty',
    purchase: unresolved, observations: [{ id: '1', evidence: { status: 'unknown' } }],
    expectedAction: 'check-gateway', requiredCitations: ['observation-1'], optionalCitations: ['budget'],
  },
  {
    name: 'Gateway accepted the transfer and polling is active',
    purchase: unresolved, observations: [{ id: '1', evidence: { status: 'pending' } }],
    expectedAction: 'wait-for-gateway', requiredCitations: ['observation-1'], optionalCitations: ['polling', 'budget'],
  },
  {
    name: 'Lookup is unavailable after the retry budget was exhausted',
    purchase: { ...unresolved, reviewRequired: true },
    observations: [{ id: '2', evidence: { status: 'unavailable' } }, { id: '1', evidence: { status: 'unknown' } }],
    expectedAction: 'escalate', requiredCitations: ['polling', 'observation-2'], optionalCitations: ['budget', 'observation-1'],
  },
  {
    name: 'A paused payment is still pending',
    purchase: { ...unresolved, reviewRequired: true },
    observations: [{ id: '1', evidence: { status: 'pending' } }],
    expectedAction: 'check-gateway', requiredCitations: ['polling', 'observation-1'], optionalCitations: ['budget'],
  },
  {
    name: 'Confirmed charge with a seller trace to retrieve',
    purchase: { ...settled, sellerHasDelivery: true },
    observations: [{ id: '1', evidence: { status: 'charged' } }],
    expectedAction: 'retrieve-delivery', requiredCitations: ['observation-1', 'buyer-delivery', 'seller-delivery'],
    optionalCitations: ['journal', 'budget'],
  },
  {
    name: 'Confirmed charge with no trace saved on either side',
    purchase: settled, observations: [{ id: '1', evidence: { status: 'charged' } }],
    expectedAction: 'contact-merchant', requiredCitations: ['observation-1', 'buyer-delivery', 'seller-delivery'],
    optionalCitations: ['journal', 'budget'],
  },
  {
    name: 'Saved buyer trace and posted journal during a Gateway outage',
    purchase: { ...settled, buyerHasDelivery: true, sellerHasDelivery: true },
    observations: [{ id: '1', evidence: { status: 'unavailable' } }],
    expectedAction: 'close-case', requiredCitations: ['journal', 'buyer-delivery'],
    optionalCitations: ['seller-delivery', 'budget'],
  },
  {
    name: 'Contradictory transfer terms survive a later outage',
    purchase: unresolved,
    observations: [{ id: '2', evidence: { status: 'unavailable' } },
      { id: '1', evidence: { status: 'conflict', reason: 'transfer-mismatch' } }],
    expectedAction: 'review-conflict', requiredCitations: ['observation-1'], optionalCitations: ['observation-2', 'budget'],
  },
  {
    name: 'A failed transfer conflicts with a posted journal',
    purchase: settled, observations: [{ id: '1', evidence: { status: 'failed' } }],
    expectedAction: 'review-conflict', requiredCitations: ['journal', 'observation-1'], optionalCitations: ['budget'],
  },
  {
    name: 'Terminal failure with no charge or delivery',
    purchase: { ...unresolved, budgetStatus: 'released' },
    observations: [{ id: '1', evidence: { status: 'failed' } }],
    expectedAction: 'close-case', requiredCitations: ['observation-1'], optionalCitations: ['budget'],
  },
  {
    name: 'Reservation expired before submission',
    purchase: { ...unresolved, budgetStatus: 'released' },
    observations: [{ id: '1', evidence: { status: 'submission-expired' } }],
    expectedAction: 'close-case', requiredCitations: ['observation-1'], optionalCitations: ['budget'],
  },
];

// Input snapshots from the lost-response drill, with normalized observation IDs.
// The confirmed-before-retrieval state was reconstructed from the recovery order.
const arcRecoveryCases: GatewayTriageCase[] = [
  {
    name: 'Paid response lost before the first Gateway lookup',
    purchase: { ...unresolved, sellerHasDelivery: true },
    observations: [],
    expectedAction: 'check-gateway', requiredCitations: ['budget'],
    optionalCitations: ['buyer-delivery', 'seller-delivery'],
  },
  {
    name: 'Gateway charge confirmed before the buyer retrieves the trace',
    purchase: { ...settled, sellerHasDelivery: true },
    observations: [{ id: '2', evidence: { status: 'charged' } }, { id: '1', evidence: { status: 'pending' } }],
    expectedAction: 'retrieve-delivery', requiredCitations: ['observation-2', 'buyer-delivery', 'seller-delivery'],
    optionalCitations: ['journal', 'budget'],
  },
  {
    name: 'Recovered buyer trace and posted journal',
    purchase: { ...settled, buyerHasDelivery: true, sellerHasDelivery: true },
    observations: [{ id: '2', evidence: { status: 'charged' } }, { id: '1', evidence: { status: 'pending' } }],
    expectedAction: 'close-case', requiredCitations: ['buyer-delivery', 'journal'],
    optionalCitations: ['observation-2', 'seller-delivery', 'budget'],
  },
];

export const gatewayTriageDatasets = {
  'gateway-triage-v1': gatewayTriageCases,
  'arc-recovery-v1': arcRecoveryCases,
};
