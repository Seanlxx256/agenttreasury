'use strict';

const byId = (id) => document.getElementById(id);
const login = byId('login');
const workspace = byId('workspace');
const notice = byId('notice');
const detail = byId('detail');
const list = byId('orders');
let token = '';
let selected = '';
let generation = 0;
let selection = 0;
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
  const response = await fetch('/finance/payment-intents' + path, {
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

login.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = byId('token');
  const button = login.querySelector('button');
  token = input.value.trim();
  input.value = '';
  button.disabled = true;
  void showErrors(async () => {
    try {
      await refresh();
      workspace.hidden = false;
      login.hidden = true;
      byId('refresh').hidden = false;
    } catch (error) {
      token = '';
      list.replaceChildren();
      detail.replaceChildren();
      throw error;
    } finally {
      button.disabled = false;
    }
  });
});
byId('refresh').addEventListener('click', () => showErrors(() => refresh()));
byId('logout').addEventListener('click', () => {
  clearTimeout(pollTimer);
  generation++;
  token = '';
  selected = '';
  list.replaceChildren();
  detail.replaceChildren();
  workspace.hidden = true;
  login.hidden = false;
  byId('refresh').hidden = true;
  notice.textContent = '';
  byId('token').focus();
});
