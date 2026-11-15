'use strict';

const byId = (id) => document.getElementById(id);
const login = byId('login');
const workspace = byId('workspace');
const notice = byId('notice');
const detail = byId('detail');
const list = byId('orders');
const gatewayLookup = byId('gateway-lookup');
const gatewayDetail = byId('gateway-detail');
const gatewayQueue = byId('gateway-queue');
let token = '';
let role = '';
let selected = '';
let generation = 0;
let selection = 0;
let gatewaySelection = 0;
let pollTimer;
const executionLabels = {
  QUEUED: 'Queued for worker',
  PROCESSING: 'Preparing refund',
  SUBMITTED: 'Broadcast · awaiting finality',
  RECORDED: 'Refund recorded',
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api(path, options = {}) {
  return financeApi('/payment-intents' + path, options);
}

async function financeApi(path, options = {}) {
  const response = await fetch('/finance' + path, {
    ...options,
    headers: { Authorization: 'Bearer ' + token, ...(options.headers ?? {}) },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.code?.replaceAll('_', ' ').toLowerCase() ?? 'Request failed');
  return value;
}

function amount(value) {
  const digits = String(value).padStart(7, '0');
  return digits.slice(0, -6) + '.' + digits.slice(-6).replace(/0+$/, '').padEnd(2, '0') + ' USDC';
}

function timestamp(date) {
  return date ? new Date(date).toLocaleString() : '—';
}

function transaction(hash) {
  if (!/^0x[0-9a-f]{64}$/i.test(hash ?? '')) return element('span', '—');
  const link = element('a', hash.slice(0, 10) + '…' + hash.slice(-6));
  link.href = 'https://sepolia.basescan.org/tx/' + hash;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function metadata(pairs) {
  const dl = element('dl', undefined, 'meta');
  for (const [label, value] of pairs) {
    const dd = element('dd');
    dd.append(value instanceof Node ? value : String(value ?? '—'));
    dl.append(element('dt', label), dd);
  }
  return dl;
}

function showGatewayPurchase(purchase, path, session) {
  const check = element('button', 'Check Gateway');
  check.type = 'button';
  check.addEventListener('click', () => showErrors(async () => {
    check.disabled = true;
    try {
      await financeApi(path + '/check', { method: 'POST' });
      if (session !== generation || !check.isConnected) return;
      const [updated] = await Promise.all([financeApi(path), refreshGatewayQueue()]);
      if (session === generation && check.isConnected) showGatewayPurchase(updated, path, session);
    } finally {
      check.disabled = false;
    }
  }));
  const review = element('button', 'Triage purchase');
  const triage = element('section');
  triage.setAttribute('aria-live', 'polite');
  review.type = 'button';
  review.addEventListener('click', () => showErrors(async () => {
    review.disabled = true;
    triage.replaceChildren(element('p', 'Reviewing saved evidence…'));
    try {
      const result = await financeApi(path + '/triage', { method: 'POST' });
      if (session === generation && review.isConnected) showTriage(triage, result);
    } catch (error) {
      if (session === generation && review.isConnected) triage.replaceChildren();
      throw error;
    } finally {
      review.disabled = false;
    }
  }));
  const actions = element('div', undefined, 'actions');
  actions.append(check, review);
  gatewayDetail.replaceChildren(metadata([
    ['Request ID', purchase.id], ['Authorization nonce', purchase.nonce],
    ['Payer', purchase.payer], ['Recipient', purchase.recipient],
    ['Amount', amount(purchase.amountUnits)], ['Authorization saved', timestamp(purchase.issuedAt)],
    ['Task', purchase.taskId], ['Task budget', purchase.budgetStatus ?? 'Untracked'],
    ['Seller delivery', purchase.sellerHasDelivery ? 'Saved' : 'Missing'],
    ['Buyer delivery', purchase.buyerHasDelivery ? 'Saved' : 'Missing'],
  ]), actions, element('h3', 'Gateway observations'));
  if (purchase.reviewRequired) {
    actions.after(element('p', 'Automatic checks paused. Review the Gateway observations.', 'muted'));
  }
  if (purchase.journal) {
    const { transferId, batchHash, postedAt, lines } = purchase.journal;
    const entries = element('ul', undefined, 'reports');
    for (const line of lines) {
      entries.append(element('li', [line.side, line.account.replaceAll('_', ' ').toLowerCase(), amount(line.amount)].join(' · ')));
    }
    actions.after(element('h3', 'Gateway journal'), metadata([
      ['Transfer ID', transferId], ['Batch hash', batchHash], ['Posted', timestamp(postedAt)],
    ]), entries);
  }
  actions.after(triage);
  if (!purchase.observations.length) {
    gatewayDetail.append(element('p', 'No Gateway check recorded.', 'muted'));
    return;
  }
  const history = element('ul', undefined, 'reports');
  for (const { checkedAt, source, evidence } of purchase.observations) {
    const row = element('li');
    row.append(element('strong', evidence.status.replaceAll('-', ' ')),
      element('span', ' · ' + source + ' · ' + timestamp(checkedAt)));
    if (evidence.reason) row.append(element('div', evidence.reason.replaceAll('-', ' ')));
    if (evidence.id) row.append(element('div', 'Transfer ID ' + evidence.id));
    if (evidence.txHash) row.append(element('div', 'Batch hash ' + evidence.txHash));
    history.append(row);
  }
  gatewayDetail.append(history);
}

function showTriage(container, { facts, rules, agent }) {
  const byRef = new Map(facts.map(({ id, description }) => [id, description]));
  const recommendation = (label, { action, rationale, citations }) => {
    const evidence = element('ul', undefined, 'reports');
    for (const id of citations) evidence.append(element('li', id + ' · ' + byRef.get(id)));
    return [element('h3', label), element('strong', action.replaceAll('-', ' ')), element('p', rationale), evidence];
  };
  container.replaceChildren(...recommendation('Rule recommendation', rules));
  if (agent.status === 'ready') {
    container.append(...recommendation('Agent recommendation', agent.recommendation));
  } else {
    const messages = {
      disabled: 'Configure a local model to add an agent recommendation.',
      unavailable: 'The local model is unavailable.',
      rejected: 'The model response did not match the allowed actions and evidence.',
    };
    container.append(element('p', messages[agent.status], 'muted'));
  }
}

async function lookupGatewayPurchase(id) {
  const session = generation;
  const selection = ++gatewaySelection;
  const path = '/gateway-purchases/' + encodeURIComponent(id);
  byId('gateway-id').value = id;
  gatewayDetail.replaceChildren(element('p', 'Loading purchase…'));
  try {
    const purchase = await financeApi(path);
    if (session === generation && selection === gatewaySelection) showGatewayPurchase(purchase, path, session);
  } catch (error) {
    if (session !== generation || selection !== gatewaySelection) return;
    gatewayDetail.replaceChildren();
    throw error;
  }
}

const gatewayReviewLabels = {
  'payment-conflict': 'Conflicting payment evidence',
  'charged-delivery-missing': 'Charged · buyer delivery missing',
  'checks-paused': 'Automatic checks paused',
};

async function refreshGatewayQueue() {
  const session = generation;
  const rows = await financeApi('/gateway-purchases/review-queue');
  if (session !== generation) return;
  gatewayQueue.replaceChildren();
  for (const row of rows) {
    const label = gatewayReviewLabels[row.reason];
    const button = element('button', undefined, 'order');
    button.type = 'button';
    button.append(element('strong', label + ' · ' + amount(row.amountUnits)),
      element('div', row.id + ' · ' + timestamp(row.issuedAt), 'muted'));
    button.addEventListener('click', () => showErrors(() => lookupGatewayPurchase(row.id)));
    const entry = element('li');
    entry.append(button);
    gatewayQueue.append(entry);
  }
  if (!rows.length) gatewayQueue.append(element('li', 'No Arc purchases need review.', 'muted'));
}

gatewayLookup.addEventListener('submit', (event) => {
  event.preventDefault();
  void showErrors(() => lookupGatewayPurchase(byId('gateway-id').value));
});

function journal(title, entry, demo) {
  const section = element('section');
  section.append(element('h3', title));
  if (!entry) {
    section.append(element('p', 'No entry recorded.', 'muted'));
    return section;
  }
  section.append(metadata([['Transaction', demo ? 'Local simulation' : transaction(entry.transactionHash)], ['Posted', timestamp(entry.postedAt)]]));
  const table = element('table');
  const heading = table.createTHead().insertRow();
  for (const key of ['Account', 'Side', 'Amount']) heading.append(element('th', key));
  const rows = table.createTBody();
  for (const line of entry.lines) {
    const row = rows.insertRow();
    row.append(element('td', line.account.replaceAll('_', ' ').toLowerCase()),
      element('td', line.side), element('td', amount(line.amount)));
  }
  section.append(table);
  return section;
}

async function select(id, background = false) {
  clearTimeout(pollTimer);
  const session = generation;
  const request = ++selection;
  selected = id;
  for (const button of list.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.id === id));
  }
  if (!background) detail.replaceChildren(element('p', 'Loading payment…'));
  const result = await api('/' + encodeURIComponent(id));
  if (session !== generation || request !== selection) return;
  const { order, ledger, reconciliation, localDemo } = result;
  const demo = order.network === 'demo:local';
  const fulfillment = order.deliveredAt ? 'Delivered ' + timestamp(order.deliveredAt)
    : order.refundHash ? 'Blocked by refund' : order.refundStatus === 'APPROVED' ? 'Blocked by approval'
      : order.refundStatus === 'DENIED' ? 'Eligible for delivery' : 'Awaiting delivery';
  detail.replaceChildren(
    element('h2', amount(order.amount) + (demo ? ' · Local demo' : '')),
    metadata([['Payment intent', order.id], ['Task', order.taskId], ['Merchant', order.payee],
      ['Settlement', order.status], ['Delivery', fulfillment], ['Created', timestamp(order.createdAt)]]),
    element('h3', 'Refund request'),
    metadata([['Decision', order.refundStatus ?? 'No request'], ['Reason', order.refundReason],
      ['Decided', timestamp(order.decidedAt)],
      ['Execution', executionLabels[order.refundExecution] ??
        (order.refundStatus === 'APPROVED' ? 'Awaiting refund' : '—')],
      ...(order.submittedRefundHash && !order.refundHash
        ? [['Refund transaction', transaction(order.submittedRefundHash)]] : [])]),
  );
  if (order.refundStatus === 'PENDING' && !order.refundHash) {
    const actions = element('div', undefined, 'actions');
    for (const [decision, label] of [['APPROVED', 'Approve refund'], ['DENIED', 'Deny refund']]) {
      const button = element('button', label, decision === 'APPROVED' ? 'primary' : undefined);
      button.disabled = decision === 'APPROVED' && Boolean(order.deliveredAt);
      button.addEventListener('click', async () => {
        for (const control of actions.querySelectorAll('button')) control.disabled = true;
        try {
          await api('/' + encodeURIComponent(id) + '/refund-decision', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
          });
          if (session !== generation) return;
          notice.textContent = 'Refund request ' + decision.toLowerCase() + '.';
          await refresh(selected);
        } catch (error) {
          if (session === generation) {
            notice.textContent = error.message;
            for (const control of actions.querySelectorAll('button')) {
              control.disabled = control.classList.contains('primary') && Boolean(order.deliveredAt);
            }
          }
        }
      });
      actions.append(button);
    }
    detail.append(actions);
  }
  if (localDemo && demo && !order.refundHash && !order.deliveredAt &&
      ['APPROVED', 'DENIED'].includes(order.refundStatus)) {
    const refund = order.refundStatus === 'APPROVED';
    const button = element('button', refund ? 'Simulate refund' : 'Simulate delivery', 'primary');
    button.addEventListener('click', () => showErrors(async () => {
      button.disabled = true;
      try {
        await api('/' + encodeURIComponent(id) + (refund ? '/demo-refund' : '/demo-deliver'), { method: 'POST' });
        if (session !== generation) return;
        notice.textContent = refund ? 'Simulated refund recorded.' : 'Simulated delivery recorded.';
        await refresh(selected);
      } finally {
        button.disabled = false;
      }
    }));
    const actions = element('div', undefined, 'actions');
    actions.append(button);
    detail.append(actions);
  }
  if (order.network === 'eip155:84532' && order.status === 'SETTLED' &&
      order.refundStatus === 'APPROVED' && !order.refundHash && !order.deliveredAt &&
      (!order.refundExecution || order.refundExecutionError)) {
    const button = element('button', order.refundExecutionError ? 'Retry testnet refund' : 'Send testnet refund', 'primary');
    button.addEventListener('click', () => showErrors(async () => {
      button.disabled = true;
      try {
        const queued = await api('/' + encodeURIComponent(id) + '/testnet-refund', { method: 'POST' });
        if (session !== generation) return;
        notice.textContent = queued.status === 'RECORDED' ? 'Refund already recorded.' : 'Testnet refund queued.';
        if (selected === id) await select(id);
      } finally {
        button.disabled = false;
      }
    }));
    const actions = element('div', undefined, 'actions');
    actions.append(button);
    detail.append(actions);
  }
  if (order.refundExecutionError) {
    detail.append(element('p', 'Last attempt did not complete. The worker will retry.', 'muted'));
  }
  if (['QUEUED', 'PROCESSING', 'SUBMITTED'].includes(order.refundExecution) ||
      (order.refundExecution === 'RECORDED' && order.refundJobPending)) {
    pollTimer = setTimeout(() => {
      if (session === generation && request === selection) {
        select(id, true).catch((error) => {
          if (session === generation && selected === id) notice.textContent = error.message;
        });
      }
    }, 10000);
  }
  detail.append(journal('Payment journal', ledger.journal, demo), journal('Refund journal', ledger.refund, demo),
    element('h3', 'Reconciliation'));
  if (reconciliation.length === 0) {
    detail.append(element('p', demo ? 'Local simulation has no on-chain reconciliation.' : 'No matching reconciliation report yet.', 'muted'));
  } else {
    const reports = element('ul', undefined, 'reports');
    for (const report of reconciliation) {
      const scope = [report.payment && 'Payment', report.refund && 'Refund', report.discrepancy && 'Intent discrepancy']
        .filter(Boolean).join(', ');
      reports.append(element('li', [report.status, scope, 'block ' + report.toBlock, timestamp(report.checkedAt)].join(' · ')));
    }
    detail.append(reports);
  }
}

async function refresh(preferred = selected) {
  const session = generation;
  const rows = await api('');
  if (session !== generation) return;
  list.replaceChildren();
  for (const row of rows) {
    const button = element('button', undefined, 'order');
    button.dataset.id = row.id;
    const title = element('span');
    title.append(element('strong', amount(row.amount)), element('span', row.status, 'pill'));
    button.append(title, element('small', row.id.slice(0, 8) + ' · ' + (row.network === 'demo:local' ? 'Local demo · ' : '') + (row.refundStatus ?? timestamp(row.createdAt))));
    button.addEventListener('click', () => showErrors(() => select(row.id)));
    const item = element('li');
    item.append(button);
    list.append(item);
  }
  if (rows.length) {
    await select(rows.some((row) => row.id === preferred) ? preferred : rows[0].id);
  } else {
    selected = '';
    list.append(element('li', 'No payment intents found.', 'empty'));
    detail.replaceChildren(element('p', 'Select a payment to view details.'));
  }
}

async function showErrors(action) {
  const session = generation;
  notice.textContent = '';
  try { await action(); } catch (error) {
    if (session === generation) notice.textContent = error.message;
  }
}

async function refreshConsole() {
  await Promise.all([refreshGatewayQueue(), role === 'finance' ? refresh() : undefined]);
}

login.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = byId('token');
  const button = login.querySelector('button');
  token = input.value.trim();
  input.value = '';
  button.disabled = true;
  void showErrors(async () => {
    try {
      ({ role } = await financeApi('/session'));
      byId('base-orders').hidden = role !== 'finance';
      detail.hidden = role !== 'finance';
      byId('console-description').textContent = role === 'finance'
        ? 'Review agent payments, refund requests, and settlement evidence.'
        : 'Review Arc Gateway payments and delivery incidents.';
      await refreshConsole();
      workspace.hidden = false;
      login.hidden = true;
      byId('session-actions').hidden = false;
    } catch (error) {
      token = '';
      role = '';
      list.replaceChildren();
      detail.replaceChildren();
      gatewayQueue.replaceChildren();
      throw error;
    } finally {
      button.disabled = false;
    }
  });
});
byId('refresh').addEventListener('click', () => showErrors(refreshConsole));
byId('logout').addEventListener('click', () => {
  clearTimeout(pollTimer);
  generation++;
  token = '';
  role = '';
  selected = '';
  list.replaceChildren();
  detail.replaceChildren();
  gatewayLookup.reset();
  gatewayDetail.replaceChildren();
  gatewayQueue.replaceChildren();
  workspace.hidden = true;
  login.hidden = false;
  byId('session-actions').hidden = true;
  byId('console-description').textContent = 'Review agent payments and settlement evidence.';
  notice.textContent = '';
  byId('token').focus();
});
