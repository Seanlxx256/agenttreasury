import type { InvestigationKind } from './gateway-investigation.js';

export type GatewayInvestigationCase = {
  name: string;
  facts: Array<{ id: string; description: string }>;
  expected: InvestigationKind[];
};

const observation = (id: string, status: string, reason?: string) =>
  ({ id: 'observation-' + id, description: 'Gateway observation: ' + status + (reason ? ' (' + reason + ')' : '') });

// Conflict scenarios authored separately from the extraction dataset. The
// expected list is the read-only check a human would run first, not a generic
// checklist. The rule baseline always proposes chain receipt + local journal +
// transfer-terms comparison, so a case's increment is how much the model closes
// the gap to the targeted checks.
export const gatewayInvestigationCases: GatewayInvestigationCase[] = [
  {
    name: 'one nonce matched by several transfers',
    facts: [
      observation('42', 'conflict', 'multiple-transfers'),
      { id: 'journal', description: 'A payment journal entry has been posted.' },
      { id: 'buyer-delivery', description: 'Buyer saved the trace.' },
      { id: 'seller-delivery', description: 'Seller saved the trace.' },
    ],
    expected: ['read-chain-receipt', 'compare-transfer-terms', 'read-gateway-status'],
  },
  {
    name: 'transfer terms contradict the authorization',
    facts: [
      observation('42', 'conflict', 'transfer-mismatch'),
      { id: 'budget', description: 'Task budget: reserved' },
    ],
    expected: ['compare-transfer-terms', 'read-original-authorization'],
  },
  {
    name: 'posted journal disagrees with the Gateway charge',
    facts: [
      observation('42', 'conflict', 'accounting-mismatch'),
      { id: 'journal', description: 'A payment journal entry has been posted.' },
    ],
    expected: ['read-local-journal', 'compare-transfer-terms'],
  },
  {
    name: 'Gateway charged but no local journal exists',
    facts: [
      observation('42', 'charged'),
      { id: 'journal-missing', description: 'Gateway reports a charge and no local payment journal was found.' },
      { id: 'budget', description: 'Task budget: spent' },
    ],
    expected: ['read-local-journal', 'read-gateway-status'],
  },
  {
    name: 'Gateway failed after a journal was posted',
    facts: [
      observation('42', 'failed'),
      { id: 'journal', description: 'A payment journal entry has been posted.' },
    ],
    expected: ['read-chain-receipt', 'read-local-journal'],
  },
  {
    name: 'delivery violates the merchant commitment',
    facts: [
      { id: 'delivery-commitment', description: "The delivery violates the merchant's commitment." },
      { id: 'buyer-delivery', description: 'Buyer saved the trace.' },
      observation('42', 'charged'),
      { id: 'journal', description: 'A payment journal entry has been posted.' },
    ],
    expected: ['read-merchant-recipient', 'read-chain-receipt'],
  },
  {
    name: 'Gateway charged and neither side saved a trace',
    facts: [
      observation('42', 'charged'),
      { id: 'buyer-delivery', description: 'Buyer trace is missing.' },
      { id: 'seller-delivery', description: 'Seller trace is missing.' },
      { id: 'budget', description: 'Task budget: spent' },
    ],
    expected: ['read-original-authorization', 'read-gateway-status'],
  },
  {
    name: 'checks paused and the latest lookup is unavailable',
    facts: [
      { id: 'polling', description: 'Automatic checks are paused.' },
      observation('42', 'unavailable'),
      { id: 'budget', description: 'Task budget: reserved' },
    ],
    expected: ['read-gateway-status', 'read-original-authorization'],
  },
];
