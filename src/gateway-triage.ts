export type TriageObservation = { id: string; evidence: { status: string; reason?: string } };

type TriagePurchase = {
  budgetStatus: string | null;
  reviewRequired: boolean;
  buyerHasDelivery: boolean;
  sellerHasDelivery: boolean;
  journal: unknown;
};

type Fact = { id: string; description: string };
export type TriageAction = 'review-conflict' | 'retrieve-delivery' | 'contact-merchant' |
  'check-gateway' | 'wait-for-gateway' | 'close-case' | 'escalate';
export type TriageRecommendation = { action: TriageAction; rationale: string; citations: string[] };

const decisive = new Set(['charged', 'failed', 'conflict']);
const gatewayStatuses = new Set([
  'unknown', 'unavailable', 'pending', 'charged', 'failed', 'conflict', 'submission-expired',
]);
const conflictReasons = new Set(['multiple-transfers', 'transfer-mismatch', 'accounting-mismatch']);

export function prepareGatewayTriage(purchase: TriagePurchase, observations: TriageObservation[]) {
  const facts: Fact[] = [
    { id: 'budget', description: 'Task budget: ' + (purchase.budgetStatus ?? 'untracked') },
    { id: 'buyer-delivery', description: purchase.buyerHasDelivery ? 'Buyer saved the trace.' : 'Buyer trace is missing.' },
    { id: 'seller-delivery', description: purchase.sellerHasDelivery ? 'Seller saved the trace.' : 'Seller trace is missing.' },
    { id: 'polling', description: purchase.reviewRequired ? 'Automatic checks are paused.' : 'Automatic checks are not marked paused.' },
  ];
  if (purchase.journal) facts.push({ id: 'journal', description: 'A payment journal entry has been posted.' });
  for (const { id, evidence } of observations) {
    if (!gatewayStatuses.has(evidence.status)) continue;
    const reason = evidence.reason && conflictReasons.has(evidence.reason) ? ' (' + evidence.reason + ')' : '';
    facts.push({ id: 'observation-' + id, description: 'Gateway observation: ' + evidence.status + reason });
  }

  const latest = observations[0];
  const decision = observations.find(({ evidence }) => decisive.has(evidence.status));
  if (!purchase.journal && decision?.evidence.status === 'charged') {
    facts.push({ id: 'journal-missing', description: 'Gateway reports a charge and no local payment journal was found.' });
  }
  const ended = decision?.evidence.status === 'failed' ? decision
    : latest?.evidence.status === 'submission-expired' ? latest : undefined;
  const paymentRef = purchase.journal && decision?.evidence.status !== 'charged' ? 'journal'
    : decision ? 'observation-' + decision.id : 'journal';
  let rules: TriageRecommendation;
  if (decision?.evidence.status === 'conflict') {
    rules = { action: 'review-conflict', rationale: 'Review the conflicting payment evidence and its accounting impact.',
      citations: ['observation-' + decision.id] };
  } else if (ended && (purchase.journal || purchase.buyerHasDelivery || purchase.sellerHasDelivery)) {
    const localRef = purchase.journal ? 'journal' : purchase.buyerHasDelivery ? 'buyer-delivery' : 'seller-delivery';
    rules = { action: 'review-conflict', rationale: 'The uncharged outcome conflicts with a local payment or delivery record.',
      citations: [localRef, 'observation-' + ended.id] };
  } else if (purchase.journal || decision?.evidence.status === 'charged') {
    if (purchase.buyerHasDelivery) {
      rules = { action: 'close-case',
        rationale: purchase.journal
          ? 'The payment journal has been posted and the buyer trace is saved.'
          : 'A confirmed payment and a saved buyer trace are on record.',
        citations: [...new Set([paymentRef, 'buyer-delivery', ...(purchase.journal ? ['journal'] : [])])] };
    } else {
      rules = { action: purchase.sellerHasDelivery ? 'retrieve-delivery' : 'contact-merchant',
        rationale: purchase.sellerHasDelivery
          ? 'The buyer trace is missing and the seller has a saved copy.'
          : 'The charge is confirmed and the seller has no saved copy. Ask the merchant to investigate.',
        citations: [paymentRef, 'buyer-delivery', 'seller-delivery'] };
    }
  } else if (ended) {
    rules = { action: 'close-case', rationale: 'The recorded evidence shows this attempt ended without a charge.',
      citations: ['observation-' + ended.id] };
  } else if (purchase.reviewRequired && latest?.evidence.status === 'unavailable') {
    rules = { action: 'escalate', rationale: 'Automatic checks are paused and the latest Gateway lookup was unavailable.',
      citations: ['polling', 'observation-' + latest.id] };
  } else if (purchase.reviewRequired && latest?.evidence.status === 'pending') {
    rules = { action: 'check-gateway', rationale: 'Automatic checks are paused and the payment is pending. Check the original authorization.',
      citations: ['polling', 'observation-' + latest.id] };
  } else if (purchase.reviewRequired || latest?.evidence.status !== 'pending') {
    rules = { action: 'check-gateway', rationale: 'Collect a fresh observation for the original authorization.',
      citations: latest && gatewayStatuses.has(latest.evidence.status) ? ['observation-' + latest.id] : ['budget'] };
  } else {
    rules = { action: 'wait-for-gateway', rationale: 'Gateway reports the payment is pending.',
      citations: ['observation-' + latest.id] };
  }

  const allowed = [rules];
  if (rules.action === 'wait-for-gateway') {
    allowed.push({ action: 'check-gateway', rationale: 'Check the original authorization again.',
      citations: rules.citations });
  }
  if (rules.action !== 'review-conflict' && rules.action !== 'escalate') {
    allowed.push({ action: 'escalate', rationale: 'Ask an operator to assess the existing evidence.',
      citations: rules.citations });
  }
  return { facts, rules, allowed };
}

export async function reviewGatewayTriage(
  input: ReturnType<typeof prepareGatewayTriage>, model?: string, request: typeof fetch = fetch,
  mode: 'choose-action' | 'support-rules' = 'choose-action',
) {
  const { facts, rules } = input;
  const supportingRules = mode === 'support-rules';
  const allowed = supportingRules ? [rules] : input.allowed;
  const maxCitations = supportingRules ? rules.citations.length + 2 : 8;
  if (!model) return { facts, rules, agent: { status: 'disabled' as const } };
  const schema = {
    type: 'object', required: ['action', 'citations'], additionalProperties: false,
    properties: {
      action: { type: 'string', enum: allowed.map(({ action }) => action) },
      citations: { type: 'array', minItems: 1, uniqueItems: true, maxItems: maxCitations,
        items: { type: 'string', enum: facts.map(({ id }) => id) } },
    },
  };
  let result: unknown;
  try {
    const response = await request('http://127.0.0.1:11434/api/chat', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, format: schema, options: { temperature: 0, num_predict: 512 },
        messages: [
          { role: 'system', content: supportingRules
            ? 'The action has already been decided. Return that action and copy all requiredCitations into citations. Add up to two supplied fact IDs only if they help the operator understand why this action is appropriate. Leave out unrelated facts.'
            : 'Select the best action from allowed using the facts. Return JSON with action and citations. Copy requiredCitations from the selected action into citations exactly.' },
          { role: 'user', content: JSON.stringify({
            facts, allowed: allowed.map(({ action, citations }) => ({ action, requiredCitations: citations })),
          }) },
        ],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { facts, rules, agent: { status: 'unavailable' as const } };
    }
    const envelope = await response.json();
    const content = envelope?.message?.content;
    if (typeof content === 'string' && content.length <= 4000) {
      try { result = JSON.parse(content); } catch { /* The output is rejected below. */ }
    }
  } catch {
    return { facts, rules, agent: { status: 'unavailable' as const } };
  }

  if (result && typeof result === 'object' && 'action' in result && 'citations' in result) {
    const { action, citations } = result;
    const option = allowed.find((candidate) => candidate.action === action);
    if (option && Array.isArray(citations) && citations.length <= maxCitations && new Set(citations).size === citations.length &&
        citations.every((id) => facts.some((fact) => fact.id === id)) &&
        option.citations.every((id) => citations.includes(id))) {
      return { facts, rules, agent: { status: 'ready' as const, model,
        recommendation: { ...option, citations } } };
    }
  }
  return { facts, rules, agent: { status: 'rejected' as const } };
}
