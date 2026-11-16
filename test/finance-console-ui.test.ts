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

async function consoleHarness(role: string) {
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
      return Response.json(path.endsWith('review-queue') ? [] : purchase);
    },
  });
  runInContext(await readFile(new URL('../../console/console.js', import.meta.url), 'utf8'), context);
  runInContext(`role = ${JSON.stringify(role)}; showGatewayPurchase(purchase, '/gateway-purchases/case-1', generation)`, context);
  return { context, root: byId('gateway-detail'), posts };
}

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
