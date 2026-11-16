// Model profiles for the triage agent.
//
// Each profile is a per-model prompt variant plus sampling options. A model
// that is not listed here falls back to `defaultTriageModelProfile`, so adding
// a model is a registry entry, not a change to the triage call path. The JSON
// schema, server-side validation, and server-supplied rationale in
// `gateway-triage.ts` are unchanged by any profile: the model only proposes an
// action and citations, and the backend rejects anything outside the envelope.

export type TriageModelProfile = {
  name: string;
  chooseSystemPrompt: string;
  supportSystemPrompt: string;
  options: { temperature: number; num_predict: number };
};

const DEFAULT_OPTIONS = { temperature: 0, num_predict: 512 } as const;

export const defaultTriageModelProfile: TriageModelProfile = {
  name: 'default',
  chooseSystemPrompt: 'Select the best action from allowed using the facts. Return JSON with action and citations. Copy requiredCitations from the selected action into citations exactly.',
  supportSystemPrompt: 'The action has already been decided. Return that action and copy all requiredCitations into citations. Add up to two supplied fact IDs only if they help the operator understand why this action is appropriate. Leave out unrelated facts.',
  options: { ...DEFAULT_OPTIONS },
};

// Qwen models respond to an explicit condition -> action dictionary. The
// escalation line differs per model: the weak 0.5b needs a "last resort"
// framing ("otherwise only when no other action fits"), while 3b needs an
// absolute boundary ("ONLY when"). A principles prompt, or a closing note that
// repeats "escalate", makes the weak models fixate on escalation.
const qwenActionMeanings = (escalateLine: string) => [
  '- check-gateway: no usable Gateway observation yet, or polling is paused with a pending result.',
  '- wait-for-gateway: the payment is pending and polling is active.',
  '- retrieve-delivery: a charge is confirmed, the buyer trace is missing, and the seller saved a copy.',
  '- contact-merchant: a charge is confirmed and neither side saved a trace.',
  '- review-conflict: Gateway reports conflict, or a charge or failure contradicts local records.',
  '- close-case: the buyer trace and journal are both saved, or the attempt ended without a charge.',
  '- escalate: ' + escalateLine,
].join('\n');

const qwenChoosePrompt = (escalateLine: string, closing?: string) => [
  'Choose ONE action from "allowed" that best matches the facts. Return JSON with "action" and "citations".',
  '',
  'Action meanings:',
  qwenActionMeanings(escalateLine),
  ...(closing ? ['', closing] : []),
  '',
  'Copy requiredCitations from the selected action into citations exactly. Do not invent or omit citations.',
].join('\n');

export const triageModelProfiles: Record<string, TriageModelProfile> = {
  'qwen2.5:0.5b': {
    name: 'qwen2.5:0.5b',
    chooseSystemPrompt: qwenChoosePrompt(
      'polling is paused and the latest lookup is unavailable; otherwise only when no other action fits.',
    ),
    supportSystemPrompt: [
      'The action is already decided. Return that action and copy all requiredCitations into citations exactly.',
      'Then add up to two fact IDs ONLY if they change how an operator follows up after this action (for example a saved seller trace when the buyer still needs recovery, or a missing journal on a confirmed charge).',
      'Leave out unrelated facts.',
    ].join('\n'),
    options: { ...DEFAULT_OPTIONS },
  },

  // 1.5b over-escalates, so its closing note is a positive instruction that
  // names what to do without ever mentioning escalation.
  'qwen2.5:1.5b': {
    name: 'qwen2.5:1.5b',
    chooseSystemPrompt: qwenChoosePrompt(
      'polling is paused and the latest lookup is unavailable; otherwise only when no other action fits.',
      'Choose the specific action whose condition matches the facts.',
    ),
    supportSystemPrompt: [
      'The action is already decided. Return that action and copy all requiredCitations into citations exactly.',
      'Add up to two fact IDs only when they would change the operator follow-up, such as a saved seller trace before delivery recovery or a missing journal after a confirmed charge.',
      'Leave out unrelated facts.',
    ].join(' '),
    options: { ...DEFAULT_OPTIONS },
  },
  'qwen2.5:3b': {
    name: 'qwen2.5:3b',
    chooseSystemPrompt: qwenChoosePrompt(
      'ONLY when polling is paused and the latest lookup is unavailable.',
      'Match the facts against the meanings in order and pick the first specific action that fits.',
    ),
    supportSystemPrompt: [
      'The action is already decided. Return that action and copy all requiredCitations into citations exactly.',
      'Add up to two fact IDs only when they would change the operator follow-up, such as a saved seller trace before delivery recovery or a missing journal after a confirmed charge.',
      'Leave out unrelated facts.',
    ].join(' '),
    options: { ...DEFAULT_OPTIONS },
  },

  // Cross-family model: spell out the output contract and a decision order in
  // the system message, since Llama follows explicit ordering better than a
  // single "select the best action" instruction.
  'llama3.2:3b': {
    name: 'llama3.2:3b',
    chooseSystemPrompt: [
      'You are a payment triage classifier. Pick one action from "allowed" and cite its evidence.',
      'Output a single JSON object with two fields: "action" (one of the allowed values) and "citations" (the requiredCitations of that action, copied verbatim). Do not explain. Do not add citations outside the supplied facts.',
      '',
      'Decision order:',
      '1. If Gateway reports conflict, or a charge or failure contradicts local records, pick review-conflict.',
      '2. If a charge is confirmed and the buyer trace is missing, pick retrieve-delivery when the seller saved a copy, otherwise contact-merchant.',
      '3. If the buyer trace and journal are saved, or the attempt ended without a charge, pick close-case.',
      '4. If polling is paused and the latest lookup is unavailable, pick escalate.',
      '5. If the payment is pending, pick wait-for-gateway when polling is active, otherwise check-gateway.',
      '6. Otherwise pick check-gateway.',
    ].join('\n'),
    supportSystemPrompt: [
      'You are a payment triage evidence assistant. The action is already decided.',
      'Output a single JSON object with two fields: "action" (the decided action) and "citations" (the requiredCitations, plus up to two extra fact IDs only if they change the follow-up). Do not explain. Do not add unrelated facts.',
    ].join('\n'),
    options: { ...DEFAULT_OPTIONS },
  },
};

export function resolveTriageModelProfile(model: string): TriageModelProfile {
  return triageModelProfiles[model] ?? { ...defaultTriageModelProfile, name: model };
}
