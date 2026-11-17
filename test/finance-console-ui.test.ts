import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';

// A small DOM boundary for exercising the real console handlers without a
// browser dependency. HTML interpretation is forbidden so assertions stay text.
class Element {
  children: (Element | string)[] = [];
  parent?: Element;
  listeners = new Map<string, () => unknown>();
  type = '';
  disabled = false;
  checked = false;
  value = '';
  isConnected = true;
  constructor(public tag: string) {}
  set textContent(value: string) { this.children = [value]; }
  get textContent(): string { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
  set innerHTML(_: string) { throw new Error('Untrusted evidence must not be rendered as HTML'); }
  append(...children: (Element | string)[]) {
    for (const child of children) if (child instanceof Element) child.parent = this;
    this.children.push(...children);
  }
  replaceChildren(...children: (Element | string)[]) { this.children = []; this.append(...children); }
  after(...children: (Element | string)[]) {
    if (!this.parent) return;
    for (const child of children) if (child instanceof Element) child.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, ...children);
  }
  setAttribute() {}
  addEventListener(event: string, handler: () => unknown) { this.listeners.set(event, handler); }
  async fire(event: string) { if (event !== 'click' || !this.disabled) await this.listeners.get(event)?.(); }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child instanceof Element ? child.all() : [])]; }
}

async function consoleHarness(role: string, reconciliationCase?: Record<string, unknown>) {
  const elements = new Map<string, Element>();
  const byId = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element('div'));
    return elements.get(id)!;
  };
  const posts: { path: string; payload: unknown }[] = [];
  const purchase = {
    id: 'case-1', taskId: 'task-1', recipient: '0xaaa', grantRecipient: '0xaaa', merchantRecipient: '0xaaa',
    grantRecipientVersion: 0, merchantRecipientVersion: 2, amountUnits: '1000',
    disputeStatus: 'OPEN', disputeReason: 'Incorrect trace', disputeEvidence: { claim: '<script>malicious()</script>' },
    disputeAssessment: { satisfied: false }, commitmentSatisfied: false, commitmentViolations: ['Missing CALL'], observations: [],
  };
  const context = createContext({
    document: { getElementById: byId, createElement: (tag: string) => new Element(tag) },
    Node: Element, setTimeout, clearTimeout, purchase,
    fetch: async (path: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') posts.push({ path, payload: JSON.parse(init.body ?? '{}') });
      if (path.endsWith('/case-packet/history')) return Response.json({ packets: [{ packetId: '1', actor: 'operations' }], nextBefore: null });
      if (path.endsWith('/case-packet') || path.endsWith('/case-packet/revisions') || path.endsWith('/case-packet/history/1')) return Response.json({
        ...(path.endsWith('/revisions') ? { operatorReview: { topics: ['delivery-unusable'] }, changes: { topicsRemoved: ['refund-claimed'] } } : {}),
        historicalView: path.endsWith('/history/1'), packetId: path.endsWith('/revisions') ? '2' : '1', snapshot: { capturedAt: '2026-11-17T00:00:00Z', coverage: {} },
        modelInterpretation: { status: 'disabled' }, partyStatements: [{ id: 'statement-customer', data: { text: '<script>claim()</script>' } }],
        recordedFacts: [{ text: 'No verified refund posting.', citations: ['refund'] }], ruleIssues: { issues: [{ topic: 'refund-claimed' }] }, evidenceGaps: [],
        merchantInquiryDraft: { status: 'draft-not-sent', text: 'Please provide refund evidence.' }, sources: [], staleNow: true });
      if (path.includes('/reconciliation-cases')) return Response.json(path.endsWith('?status=all')
        ? { cases: [], next:null } : reconciliationCase);
      if (path.endsWith('/operations/metrics')) return Response.json({ cases:{},recovery:{},scans:{},wallets:[],workers:[] });
      return Response.json(path.endsWith('review-queue') ? [] : purchase);
    },
  });
  runInContext(await readFile(new URL('../../console/console.js', import.meta.url), 'utf8'), context);
  runInContext(`role = ${JSON.stringify(role)}; showGatewayPurchase(purchase, '/gateway-purchases/case-1', generation)`, context);
  return { context, root: byId('gateway-detail'), caseRoot:byId('reconciliation-case-detail'), posts };
}

test('case console requires an outcome and binds resolution to displayed evidence/version', async () => {
  const { context,caseRoot,posts }=await consoleHarness('operations', {
    id:'case-1',status:'investigating',version:7,latest_discrepancy_id:'evidence-1',occurrenceCount:2,
    evidence:{ id:'evidence-1',detail:'<script>untrusted()</script>' },events:[],
  });
  await runInContext("openCase('case-1')",context);
  assert.match(caseRoot.textContent,/<script>untrusted\(\)<\/script>/);
  assert.match(caseRoot.textContent,/does not release a budget/);
  const button=caseRoot.all().find((node)=>node.tag==='button' && node.textContent==='Resolve with evidence')!;
  const note=caseRoot.all().find((node)=>node.tag==='textarea')!;
  assert.equal(button.disabled,true);
  await button.fire('click'); assert.equal(posts.length,0);
  note.value='Confirmed duplicate observation; original payment remains reserved.';
  await note.fire('input'); await button.fire('click');
  assert.deepEqual(posts[0],{ path:'/finance/reconciliation-cases/case-1/transitions',payload:{
    expectedVersion:7,evidenceId:'evidence-1',status:'resolved',note:note.value,
  } });
});

test('investigation console renders untrusted evidence as text and flags stale snapshots',async()=>{
  const {context,root}=await consoleHarness('operations');
  const report={runId:'1',planner:{status:'disabled',investigations:[]},summary:{completed:1,blocked:1,unavailable:0},
    snapshot:{capturedAt:'2026-11-17T00:00:00Z',facts:[],sources:{},records:{note:'<script>refund()</script>'}},
    checks:[{kind:'read-chain-receipt',status:'blocked',reason:'No bound hash'}],staleNow:true};
  runInContext(`showInvestigation(document.getElementById('gateway-detail'), ${JSON.stringify(report)})`,context);
  assert.match(root.textContent,/Local records changed/);assert.match(root.textContent,/<script>refund\(\)<\/script>/);
  assert.match(root.textContent,/does not authorize payment/);assert.match(root.textContent,/No bound hash/);
});

test('case packet console submits party claims separately, renders text safely and shows stale advisory evidence', async () => {
  const { root, posts } = await consoleHarness('operations');
  const customer = root.all().find((node) => node.tag === 'textarea' && node.parent?.textContent === 'Customer statement')!;
  const merchant = root.all().find((node) => node.tag === 'textarea' && node.parent?.textContent === 'Merchant statement')!;
  customer.value = 'Charged twice.'; merchant.value = 'Already refunded.';
  await root.all().find((node) => node.tag === 'button' && node.textContent === 'Prepare case packet')!.fire('click');
  assert.deepEqual(posts[0], { path: '/finance/gateway-purchases/case-1/case-packet', payload: {
    customerStatement: 'Charged twice.', merchantStatement: 'Already refunded.',
  } });
  assert.match(root.textContent, /Party statements — unverified/); assert.match(root.textContent, /No verified refund posting/);
  assert.match(root.textContent, /<script>claim\(\)<\/script>/); assert.match(root.textContent, /Records changed after this snapshot/);
  assert.match(root.textContent, /Merchant inquiry draft — not sent/);
  await root.all().find((node) => node.tag === 'button' && node.textContent === 'View saved case packet')!.fire('click');
  assert.equal(customer.value, '<script>claim()</script>'); assert.equal(posts.length, 1);
});

test('case packet review requires rationale and source, submits selected topics and browses read-only history', async () => {
  const { root, posts } = await consoleHarness('operations');
  const button = (text: string) => root.all().find((n) => n.tag === 'button' && n.textContent === text)!;
  await button('View saved case packet').fire('click');
  assert.equal(button('Prepare case packet').disabled, true);
  const submit = button('Save reviewed version'); assert.equal(submit.disabled, true);
  const note = root.all().find((n) => n.tag === 'textarea' && n.parent?.textContent === 'Review rationale (required)')!;
  const text = root.all().find((n) => n.tag === 'textarea' && n.parent?.textContent.startsWith('Supplement excerpt'))!;
  const reference = root.all().find((n) => n.tag === 'input' && n.parent?.textContent.startsWith('Source reference'))!;
  note.value = 'Refund interpretation corrected to delivery problem.'; await note.fire('input');
  text.value = '<script>untrusted()</script>'; await text.fire('input'); assert.equal(submit.disabled, true);
  reference.value = 'ticket-42'; await reference.fire('input'); assert.equal(submit.disabled, false);
  for (const topic of ['refund-claimed', 'delivery-unusable']) {
    const checkbox = root.all().find((n) => n.type === 'checkbox' && n.parent?.textContent === topic)!;
    checkbox.checked = topic === 'delivery-unusable';
  }
  await submit.fire('click');
  assert.deepEqual(posts[0], { path: '/finance/gateway-purchases/case-1/case-packet/revisions', payload: {
    expectedPacketId: '1', topics: ['delivery-unusable'], note: note.value,
    supplements: [{ kind: 'merchant-reply', reference: 'ticket-42', text: '<script>untrusted()</script>' }],
  } });
  assert.match(root.textContent, /Changes from previous packet/);
  await button('Browse packet history').fire('click'); await button('View packet 1 (operations)').fire('click');
  assert.match(root.textContent, /Historical version — read only/);
  assert.equal(button('Save reviewed version'), undefined); assert.equal(posts.length, 1);
});

test('finance sees evidence before approving and submits the exact displayed version', async () => {
  const { root, posts } = await consoleHarness('finance');
  assert.match(root.textContent, /Incorrect trace/);
  assert.match(root.textContent, /<script>malicious\(\)<\/script>/);
  assert.match(root.textContent, /not independently verified/);
  assert.match(root.textContent, /Grant approval version0/);
  assert.match(root.textContent, /Merchant approved version2/);
  const button = root.all().find((node) => node.tag === 'button' && node.textContent === 'Reauthorize recipient')!;
  assert.ok(button, 'same address with a new version still needs approval');
  assert.equal(button.disabled, true);
  await button.fire('click');
  assert.equal(posts.length, 0);
  const checkbox = root.all().find((node) => node.type === 'checkbox')!;
  checkbox.checked = true;
  await checkbox.fire('change');
  await button.fire('click');
  assert.deepEqual(posts[0], { path: '/finance/gateway-grants/task-1/recipient-reauthorize',
    payload: { expectedRecipient: '0xaaa', expectedVersion: 2 } });
});

test('operations can read evidence but has no finance approval buttons', async () => {
  const { root } = await consoleHarness('operations');
  assert.match(root.textContent, /Incorrect trace/);
  assert.ok(!root.all().some((node) => node.tag === 'button' &&
    ['Approve refund', 'Dismiss dispute', 'Reauthorize recipient'].includes(node.textContent)));
});

test('triage displays model interpretations apart from record facts and preserves source references', async () => {
  const { context } = await consoleHarness('operations');
  const container = new Element('section');
  context.container = container;
  context.result = {
    facts: [{ id: 'observation-12', description: 'Gateway observation: pending', sourceText: 'Identifier was NOT reused.' }],
    inferences: [{ signal: 'nonce-reused', origin: 'model', verification: 'unverified', description: 'Possible nonce reuse',
      sources: [{ observationId: 'observation-12', quote: 'Identifier' }] }],
    rules: { action: 'wait-for-gateway', rationale: 'Wait for confirmation', citations: ['observation-12'] },
    agent: { status: 'disabled' },
  };
  runInContext('showTriage(container, result)', context);
  assert.match(container.textContent, /Verified record facts/);
  assert.match(container.textContent, /Unverified interpretations/);
  assert.match(container.textContent, /Model inference/);
  assert.match(container.textContent, /observation-12: "Identifier"/);
  assert.match(container.textContent, /cannot authorize payment or close a case/);
});
