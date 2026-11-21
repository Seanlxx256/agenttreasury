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
const gatewayPatterns = byId('gateway-patterns');
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

function evidenceBlock(title, value) {
  const section = element('section');
  section.append(element('h3', title), element('pre', JSON.stringify(value ?? null, null, 2)));
  return section;
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
  const investigation = element('section');
  const external = element('input');
  external.type = 'checkbox';
  const externalLabel = element('label');
  externalLabel.append(external, ' Refresh Gateway and chain evidence (read only)');
  const investigate = element('button', 'Collect investigation evidence');
  const savedInvestigation = element('button', 'View saved investigation');
  const checkpoints = element('button', 'View investigation checkpoints');
  for (const [button, fresh] of [[investigate, true], [savedInvestigation, false]]) {
    button.type = 'button';
    button.addEventListener('click', () => showErrors(async () => {
      button.disabled = true;
      try {
        const result = await financeApi(path + '/investigation', fresh ? { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshExternal: external.checked }) } : {});
        if (session === generation && button.isConnected) showInvestigation(investigation, result);
      } finally { button.disabled = false; }
    }));
  }
  checkpoints.addEventListener('click', () => showErrors(async () => {
    checkpoints.disabled = true;
    try {
      const result = await financeApi(path + '/investigation/checkpoints');
      if (session !== generation || !checkpoints.isConnected) return;
      investigation.replaceChildren(element('h3', 'Investigation checkpoints'), element('p',
        'Saved checks are reused. An unfinished read may be repeated. Recovery keeps the original model and external-read setting, and stops if the local snapshot changed.'));
      if (!result.checkpoints.length) investigation.append(element('p', 'No investigation checkpoints found.'));
      for (const item of result.checkpoints) {
        const row = element('section');
        row.append(metadata([['Checkpoint', item.id], ['Status', item.status], ['Saved checks', item.savedChecks],
          ['Attempts', item.attempts], ['Model', item.model || 'rules'], ['External reads', item.refreshExternal ? 'enabled' : 'disabled']]));
        const view = element('button', 'View checkpoint evidence');
        view.addEventListener('click', () => showErrors(async () => {
          view.disabled = true;
          try {
            const saved = await financeApi(path + '/investigation/checkpoints/' + item.id);
            if (session === generation && view.isConnected) {
              const detail = element('section'); detail.append(evidenceBlock('Saved progress (not a freshness check)', saved)); row.append(detail);
            }
          } finally { view.disabled = false; }
        }));
        row.append(view);
        if (item.status === 'in-progress') {
          const resume = element('button', 'Resume saved investigation');
          resume.addEventListener('click', () => showErrors(async () => {
            resume.disabled = true;
            try {
              const report = await financeApi(path + '/investigation/checkpoints/' + item.id + '/resume', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
              if (session === generation && resume.isConnected) showInvestigation(investigation, report);
            } finally { resume.disabled = false; }
          }));
          row.append(resume);
        }
        investigation.append(row);
      }
    } finally { checkpoints.disabled = false; }
  }));
  actions.append(check, review, investigate, savedInvestigation, checkpoints, externalLabel);
  const approvalEvidence = element('section');
  approvalEvidence.append(element('h3', 'Approval evidence'), metadata([
    ['Dispute status', purchase.disputeStatus], ['Dispute reason', purchase.disputeReason],
    ['Dispute raised', timestamp(purchase.disputeRaisedAt)],
    ['Original payment recipient', purchase.recipient],
    ['Currently authorized recipient', purchase.grantRecipient],
    ['Grant approval version', purchase.grantRecipientVersion ?? 'Requires explicit approval'],
    ['Merchant current recipient', purchase.merchantRecipient],
    ['Merchant approved version', purchase.merchantRecipientVersion],
    ['Commitment satisfied', purchase.commitmentSatisfied ?? 'Not assessed'],
    ['Refund transaction', purchase.refundHash],
  ]));
  if (purchase.disputeStatus) {
    approvalEvidence.append(evidenceBlock('Buyer assertion (not independently verified)', purchase.disputeEvidence),
      evidenceBlock('Delivery assessment at dispute creation', purchase.disputeAssessment));
  }
  if (purchase.commitmentViolations?.length) {
    approvalEvidence.append(evidenceBlock('Recorded commitment violations', purchase.commitmentViolations));
  }
  const superseded = purchase.taskId && purchase.grantRecipient && purchase.merchantRecipient &&
    (purchase.grantRecipient.toLowerCase() !== purchase.merchantRecipient.toLowerCase() ||
      purchase.grantRecipientVersion !== purchase.merchantRecipientVersion);
  const approvalButtons = [];
  if (role === 'finance' && (purchase.disputeStatus === 'OPEN' || superseded)) {
    const acknowledge = element('input');
    acknowledge.type = 'checkbox';
    const label = element('label');
    label.append(acknowledge, ' I reviewed the dispute evidence and the recipient address/version shown above.');
    approvalEvidence.append(label);
    acknowledge.addEventListener('change', () => {
      for (const button of approvalButtons) button.disabled = !acknowledge.checked;
    });
  }
  // Dispute arbitration: once a dispute is OPEN, finance refunds or dismisses it.
  if (role === 'finance' && purchase.disputeStatus === 'OPEN') {
    for (const [decision, label] of [['REFUND', 'Approve refund'], ['DISMISS', 'Dismiss dispute']]) {
      const button = element('button', label, decision === 'REFUND' ? 'primary' : undefined);
      button.type = 'button';
      button.disabled = true;
      approvalButtons.push(button);
      button.addEventListener('click', () => showErrors(async () => {
        button.disabled = true;
        try {
          await financeApi(path + '/dispute-decision', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
          });
          if (session !== generation || !button.isConnected) return;
          const [updated] = await Promise.all([financeApi(path), refreshGatewayQueue()]);
          if (session === generation && button.isConnected) showGatewayPurchase(updated, path, session);
        } finally {
          button.disabled = false;
        }
      }));
      actions.append(button);
    }
  }
  // A superseded grant: the merchant's payout address moved after this grant was
  // issued, so finance re-authorizes it against the reviewed address.
  if (role === 'finance' && superseded) {
    const reauthorize = element('button', 'Reauthorize recipient', 'primary');
    reauthorize.type = 'button';
    reauthorize.disabled = true;
    approvalButtons.push(reauthorize);
    reauthorize.addEventListener('click', () => showErrors(async () => {
      reauthorize.disabled = true;
      try {
        await financeApi('/gateway-grants/' + encodeURIComponent(purchase.taskId) + '/recipient-reauthorize', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRecipient: purchase.merchantRecipient, expectedVersion: purchase.merchantRecipientVersion }),
        });
        if (session !== generation || !reauthorize.isConnected) return;
        const [updated] = await Promise.all([financeApi(path), refreshGatewayQueue()]);
        if (session === generation && reauthorize.isConnected) showGatewayPurchase(updated, path, session);
      } finally {
        reauthorize.disabled = false;
      }
    }));
    actions.append(reauthorize);
  }
  gatewayDetail.replaceChildren(metadata([
    ['Request ID', purchase.id], ['Authorization nonce', purchase.nonce],
    ['Payer', purchase.payer], ['Recipient', purchase.recipient],
    ['Amount', amount(purchase.amountUnits)], ['Authorization saved', timestamp(purchase.issuedAt)],
    ['Signing started', timestamp(purchase.signingStartedAt)],
    ['Task', purchase.taskId], ['Task budget', purchase.budgetStatus ?? 'Untracked'],
    ['Seller delivery', purchase.sellerHasDelivery ? 'Saved' : 'Missing'],
    ['Buyer delivery', purchase.buyerHasDelivery ? 'Saved' : 'Missing'],
  ]), approvalEvidence, actions, element('h3', 'Gateway observations'));
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
  actions.after(triage, investigation, casePacketPanel(path, session));
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

function showTriage(container, { facts, inferences = [], rules, agent, reviewId, reviewedAt }) {
  const byRef = new Map(facts.map(({ id, description }) => [id, description]));
  const evidenceList = (citations) => {
    const evidence = element('ul', undefined, 'reports');
    for (const id of citations) evidence.append(element('li', id + ' · ' + byRef.get(id)));
    return evidence;
  };
  container.replaceChildren(element('h3', 'Recommended action'), element('strong', rules.action.replaceAll('-', ' ')),
    element('p', rules.rationale), evidenceList(rules.citations));
  if (reviewId) container.append(element('p', `Saved review ${reviewId} · ${timestamp(reviewedAt)}`, 'muted'));
  container.append(element('h3', 'Verified record facts'),
    element('p', 'These facts describe saved records and reported statuses. Vendor explanations are not verified causes.', 'muted'));
  const recorded = element('ul', undefined, 'reports');
  for (const fact of facts) {
    const row = element('li', fact.id + ' · ' + fact.description);
    if (fact.sourceText) row.append(element('pre', 'Reported text: ' + fact.sourceText));
    recorded.append(row);
  }
  container.append(recorded);
  if (inferences.length) {
    container.append(element('h3', 'Unverified interpretations'),
      element('p', 'Quoted text proves the source exists, not that the interpretation is correct. These suggestions cannot authorize payment or close a case.', 'muted'));
    const interpretations = element('ul', undefined, 'reports');
    for (const inference of inferences) {
      const row = element('li', `${inference.origin === 'model' ? 'Model inference' : 'Keyword inference'} · ${inference.signal}`);
      row.append(element('p', inference.description));
      for (const source of inference.sources) row.append(element('pre', `${source.observationId}: "${source.quote}"`));
      interpretations.append(row);
    }
    container.append(interpretations);
  }
  if (agent.status === 'ready') {
    const extra = agent.recommendation.citations.filter((id) => !rules.citations.includes(id));
    if (extra.length) container.append(element('h3', 'Additional record facts selected by the agent'), evidenceList(extra));
  } else {
    const messages = {
      unavailable: 'Agent evidence selection is unavailable.',
      rejected: 'Agent evidence selection could not be verified.',
    };
    if (messages[agent.status]) container.append(element('p', messages[agent.status], 'muted'));
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
  'delivery-commitment-violated': 'Delivered · commitment violated',
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

async function refreshGatewayPatterns() {
  const session = generation;
  const rows = await financeApi('/gateway-patterns');
  if (session !== generation) return;
  gatewayPatterns.replaceChildren();
  for (const row of rows) {
    const entry = element('li');
    entry.append(element('strong', row.pattern.replaceAll('-', ' ')),
      element('div', (row.network ?? 'network') + ' · ' + row.caseIds.length + ' case(s)', 'muted'));
    gatewayPatterns.append(entry);
  }
  if (!rows.length) gatewayPatterns.append(element('li', 'No cross-case patterns.', 'muted'));
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
  await Promise.all([refreshGatewayQueue(), refreshGatewayPatterns(), refreshOperations(), role === 'finance' ? refresh() : undefined]);
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
  caseSelection++;
  for (const id of ['operations-metrics', 'reconciliation-cases', 'reconciliation-case-detail']) byId(id).replaceChildren();
  byId('cases-more').hidden = true;
  gatewayDetail.replaceChildren();
  gatewayQueue.replaceChildren();
  workspace.hidden = true;
  login.hidden = false;
  byId('session-actions').hidden = true;
  byId('console-description').textContent = 'Review agent payments and settlement evidence.';
  notice.textContent = '';
  byId('token').focus();
});

let caseSelection = 0;
let casePage = null;
let caseListGeneration = 0;

async function refreshOperations() {
  const session = generation;
  const [metrics] = await Promise.all([financeApi('/operations/metrics'), loadCases()]);
  if (session !== generation) return;
  byId('operations-metrics').replaceChildren(metadata([
    ['Snapshot observed at', metrics.observedAt],
    ['Read source', metrics.cache?.source ?? 'database'],
    ['Snapshot age at response (ms)', metrics.cache?.ageMs ?? 0],
    ['Cache window (ms)', metrics.cache?.ttlMs ?? 0],
    ['Open cases', metrics.cases.open], ['Investigating', metrics.cases.investigating],
    ['Oldest unresolved (seconds)', metrics.cases.oldestUnresolvedSeconds],
    ['Recovery due', metrics.recovery.due], ['Paused for review', metrics.recovery.pausedForReview],
    ['Failed scans', metrics.scans.failed], ['Expired scan leases', metrics.scans.expiredLeases],
  ]), evidenceBlock('Scanner lag and observation age', metrics.wallets), evidenceBlock('Worker health', metrics.workers), evidenceBlock('Latest recovery evidence', metrics.latestRecoveryEvidence));
}
async function loadCases(more = false) {
  const session = generation;
  const load = ++caseListGeneration;
  const status = byId('case-filter').value || 'all';
  const page = await financeApi('/reconciliation-cases?status=' + status + (more && casePage ? '&before=' + casePage : ''));
  if (session !== generation || load !== caseListGeneration) return;
  const root = byId('reconciliation-cases');
  if (!more) root.replaceChildren();
  casePage = page.next;
  byId('cases-more').hidden = !casePage;
  for (const item of page.cases) {
    const row = element('li');
    const button = element('button', item.kind + ' · ' + item.status + ' · ' + item.subject);
    button.addEventListener('click', () => showErrors(() => openCase(item.id)));
    row.append(button); root.append(row);
  }
  if (!more && !page.cases.length) root.append(element('li', 'No reconciliation cases.'));
}
async function openCase(id) {
  const session = generation;
  const choice = ++caseSelection;
  const value = await financeApi('/reconciliation-cases/' + id);
  if (session !== generation || choice !== caseSelection) return;
  const root = byId('reconciliation-case-detail');
  root.replaceChildren(element('h3', 'Case ' + value.id), metadata([
    ['Status', value.status], ['Version', value.version], ['Occurrences', value.occurrenceCount],
    ['First seen', timestamp(value.first_seen_at)], ['Last seen', timestamp(value.last_seen_at)],
  ]), evidenceBlock('Latest original scan evidence', value.evidence), evidenceBlock('Recent case history', value.events),
  element('p', 'Resolving a case records an operational conclusion. It does not release a budget, refund, or adjust a ledger.'));
  const note = element('textarea');
  note.maxLength = 2000;
  note.setAttribute('aria-label', 'Investigation outcome and supporting evidence');
  note.placeholder = 'Record your investigation outcome and supporting evidence.';
  const action = value.status === 'investigating' ? 'resolved' : 'investigating';
  const button = element('button', action === 'resolved' ? 'Resolve with evidence' : 'Start investigation');
  button.disabled = true;
  note.addEventListener('input', () => { button.disabled = !note.value.trim(); });
  button.addEventListener('click', () => showErrors(async () => {
    button.disabled = true;
    try {
      await financeApi('/reconciliation-cases/' + id + '/transitions', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: value.version,
          evidenceId: value.latest_discrepancy_id, status: action, note: note.value.trim() }) });
      if (session === generation && choice === caseSelection) await Promise.all([openCase(id), refreshOperations()]);
    } finally { if (button.isConnected) button.disabled = !note.value.trim(); }
  }));
  root.append(note, button);
}
byId('case-filter').addEventListener('change', () => showErrors(() => loadCases()));
byId('cases-more').addEventListener('click', () => showErrors(() => loadCases(true)));

function showInvestigation(container, report) {
  container.replaceChildren(element('h3', 'Read-only investigation'), element('p',
    'Evidence gathering only. This report does not authorize payment, refund, budget release or case closure.'),
  metadata([['Run', report.runId], ['Planner', report.planner.status], ['Captured', timestamp(report.snapshot.capturedAt)],
    ['Completed checks', report.summary.completed], ['Blocked checks', report.summary.blocked], ['Unavailable checks', report.summary.unavailable]]));
  if (report.staleAtCompletion || report.staleNow) container.append(element('p',
    'Local records changed after this snapshot. Collect fresh evidence before making an operational decision.', 'muted'));
  if (report.staleAtCompletion === null || report.staleNow === null) container.append(element('p',
    'Snapshot freshness could not be verified at completion or retrieval. Saved evidence remains available; collect fresh evidence before making an operational decision.', 'muted'));
  if (report.guided) container.append(evidenceBlock('Guided collection: steps, stopping reason and remaining checks', report.guided));
  container.append(evidenceBlock('Snapshot facts and source references', { facts: report.snapshot.facts, sources: report.snapshot.sources }),
    evidenceBlock('Selected checks and citations', report.planner.investigations));
  for (const check of report.checks) container.append(evidenceBlock(check.kind + ' · ' + check.status, check));
  container.append(evidenceBlock('Original local snapshot', report.snapshot.records));
}

function casePacketPanel(path, session) {
  const root = element('section');
  root.append(element('h3', 'Prepare an exception case packet'), element('p',
    'Enter the statements as received. They remain unverified claims. The packet saves evidence and a merchant inquiry draft; it sends no message or payment.'));
  const customer = element('textarea'); customer.maxLength = 3000;
  customer.placeholder = 'Customer statement, for example: I was charged twice and cannot open the purchased data.';
  const merchant = element('textarea'); merchant.maxLength = 3000;
  merchant.placeholder = 'Merchant statement, for example: We have already refunded the order.';
  const customerLabel = element('label', 'Customer statement'); customerLabel.append(customer);
  const merchantLabel = element('label', 'Merchant statement'); merchantLabel.append(merchant);
  const create = element('button', 'Prepare case packet'), saved = element('button', 'View saved case packet');
  const output = element('section'); output.setAttribute('aria-live', 'polite');
  let loaded = false;
  const render = (packet) => {
    loaded = true; create.disabled = true; customer.readOnly = true; merchant.readOnly = true;
    showCasePacket(output, packet);
    if (!packet.historicalView) {
      output.append(casePacketReview(packet, path, session, render));
      before = null; history.disabled = false; history.textContent = 'Browse packet history'; historyOutput.replaceChildren();
    }
  };
  for (const [button, fresh] of [[create, true], [saved, false]]) {
    button.type = 'button';
    button.addEventListener('click', () => showErrors(async () => {
      create.disabled = true; saved.disabled = true;
      try {
        const packet = await financeApi(path + '/case-packet', fresh ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerStatement: customer.value, merchantStatement: merchant.value }) } : {});
        if (session !== generation || !button.isConnected) return;
        render(packet);
        if (!fresh) {
          customer.value = packet.partyStatements.find((row) => row.id === 'statement-customer')?.data.text ?? '';
          merchant.value = packet.partyStatements.find((row) => row.id === 'statement-merchant')?.data.text ?? '';
        }
      } finally { create.disabled = loaded; saved.disabled = false; }
    }));
  }
  const history = element('button', 'Browse packet history'), historyOutput = element('section');
  history.type = 'button'; let before = null;
  history.addEventListener('click', () => showErrors(async () => {
    history.disabled = true; let completed = false;
    try {
      const page = await financeApi(path + '/case-packet/history' + (before ? '?before=' + encodeURIComponent(before) : ''));
      if (session !== generation || !history.isConnected) return;
      for (const entry of page.packets) {
        const view = element('button', `View packet ${entry.packetId} (${entry.actor})`); view.type = 'button';
        view.addEventListener('click', () => showErrors(async () => {
          const packet = await financeApi(path + '/case-packet/history/' + encodeURIComponent(entry.packetId));
          if (session !== generation || !view.isConnected) return;
          render(packet);
        }));
        historyOutput.append(view);
      }
      before = page.nextBefore; completed = true; history.textContent = before ? 'Load older packets' : 'History loaded';
    } finally { history.disabled = completed && !before; }
  }));
  const effort = element('button', 'View review effort'), effortOutput = element('section'); effort.type = 'button';
  effort.addEventListener('click', () => showErrors(async () => {
    effort.disabled = true;
    try {
      const summary = await financeApi(path + '/case-packet/effort');
      if (session !== generation || !effort.isConnected) return;
      effortOutput.replaceChildren(evidenceBlock('Review effort — descriptive, not verified time savings', summary));
    } finally { effort.disabled = false; }
  }));
  root.append(customerLabel, merchantLabel, create, saved, history, historyOutput, effort, effortOutput, output);
  return root;
}

function showCasePacket(container, report) {
  container.replaceChildren(element('h3', 'Exception case packet'), element('p',
    'Recorded facts describe local records. Party statements and topic interpretations are unverified. This packet authorizes no financial or case action.'),
  metadata([['Packet', report.packetId], ['Previous packet', report.parentPacketId ?? 'none'], ['Captured', timestamp(report.snapshot.capturedAt)], ['Model interpretation', report.modelInterpretation.status]]));
  if (report.staleAtCompletion || report.staleNow) container.append(element('p',
    'Records changed after this snapshot. Prepare a fresh packet before acting.', 'muted'));
  if (report.historicalView) container.append(element('p', 'Historical version — read only. Load the latest saved packet to review.'));
  if (!report.candidateReview) container.append(element('p', 'Legacy packet without context screening. Read the raw statements and explicitly select topics to save an updated version.'));
  if (report.candidateReview) {
    if (report.candidateReview.needsOperatorReview) container.append(element('p',
      'Context review required: some candidates are held because of statement context or rule/model disagreement. Read the complete sources before selecting topics. Held does not mean false.'));
    container.append(evidenceBlock('Context signals and candidate disagreements', report.candidateReview));
  }
  if (report.reviewEffort) container.append(evidenceBlock('Saved review effort — client timing is unverified', report.reviewEffort));
  if (report.claimAssistance) container.append(evidenceBlock('Claim states and material checklist — review required', report.claimAssistance));
  if (report.suppliedMaterials) container.append(evidenceBlock('Already supplied material candidates — unverified', report.suppliedMaterials));
  if (report.operatorReview) container.append(evidenceBlock('Operator topic review — not claim verification', report.operatorReview));
  if (report.changes) container.append(evidenceBlock('Changes from previous packet', report.changes));
  container.append(evidenceBlock('Party statements — unverified', report.partyStatements),
    evidenceBlock('Recorded facts and citations', report.recordedFacts),
    evidenceBlock('Candidate topics — unverified', { rules: report.ruleIssues, model: {
      status: report.modelInterpretation.status, issues: report.modelInterpretation.issues, reason: report.modelInterpretation.reason,
      scope: 'Original generation only; not reevaluated for revised records or supplements.',
      originalSources: report.interpretationSources ?? report.partyStatements } }),
    evidenceBlock('Missing evidence and follow-up questions', report.evidenceGaps),
    evidenceBlock('Merchant inquiry draft — not sent', report.merchantInquiryDraft),
    evidenceBlock('Source records and coverage limits', { sources: report.sources, coverage: report.snapshot.coverage }));
}


function casePacketReview(report, path, session, render) {
  const displayedAt = performance.now();
  const root = element('section');
  root.append(element('h4', 'Review topics and append evidence'), element('p',
    'Select the topics to investigate. Clearing a topic rejects its classification only; it does not prove the claim false. Saving refreshes local records and retains earlier versions.'));
  const selected = report.operatorReview?.topics ?? report.selectedTopics ?? [];
  const choices = ['duplicate-charge', 'delivery-unusable', 'refund-claimed', 'other'].map((topic) => {
    const input = element('input'); input.type = 'checkbox'; input.checked = selected.includes(topic);
    const label = element('label', topic); label.append(input); root.append(label); return { topic, input };
  });
  const note = element('textarea'); note.maxLength = 1000;
  const noteLabel = element('label', 'Review rationale (required)'); noteLabel.append(note);
  const kind = element('select');
  for (const value of ['merchant-reply', 'customer-reply', 'operator-observation']) {
    const option = element('option', value); option.value = value; kind.append(option);
  }
  kind.value = 'merchant-reply';
  const kindLabel = element('label', 'Supplement source type'); kindLabel.append(kind);
  const reference = element('input'); reference.type = 'text'; reference.maxLength = 300;
  const referenceLabel = element('label', 'Source reference (for example, support ticket ID)'); referenceLabel.append(reference);
  const text = element('textarea'); text.maxLength = 1500;
  const textLabel = element('label', 'Supplement excerpt (optional, redact credentials and private data)'); textLabel.append(text);
  const save = element('button', 'Save reviewed version'); save.type = 'button'; save.disabled = true;
  let saving = false;
  const validate = () => { save.disabled = saving || !note.value.trim() || (!!text.value.trim() !== !!reference.value.trim()); };
  for (const field of [note, reference, text]) field.addEventListener('input', validate);
  save.addEventListener('click', () => showErrors(async () => {
    saving = true; validate();
    const elapsed = Math.round(performance.now() - displayedAt);
    const timing = { origin: 'interactive-declared', elapsedMs: Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 3600000 ? elapsed : null };
    try {
      const packet = await financeApi(path + '/case-packet/revisions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timing, expectedPacketId: report.packetId, topics: choices.filter((c) => c.input.checked).map((c) => c.topic),
          note: note.value.trim(), supplements: text.value.trim() ? [{ kind: kind.value, reference: reference.value.trim(), text: text.value.trim() }] : [] }) });
      if (session !== generation || !save.isConnected) return;
      render(packet);
    } finally { saving = false; validate(); }
  }));
  root.append(noteLabel, kindLabel, referenceLabel, textLabel, save, element('p',
    'Supplemental material is operator-entered and unverified. References are stored as text, never fetched. On a version conflict, load the latest saved packet and review again. This form records client-reported time since display, including idle time; reloads restart timing and sessions over one hour are untimed. It does not prove human work or time savings.'));
  return root;
}
