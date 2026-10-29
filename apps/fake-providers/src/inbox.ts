import { maskIdNumber } from './identity';
import { escapeHtml } from './shared';
import type { Captured, FakeStore } from './store';

const cell = (value: unknown) =>
  `<td>${escapeHtml(value === undefined || value === null ? '' : String(value))}</td>`;

const table = (headings: readonly string[], rows: readonly string[], empty: string) =>
  `<table><thead><tr>${headings.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.length
      ? rows.join('')
      : `<tr><td colspan="${headings.length}">${escapeHtml(empty)}</td></tr>`
  }</tbody></table>`;

function messageText(m: Captured): string {
  const title = typeof m.meta?.title === 'string' ? `${m.meta.title}: ` : '';
  return `${title}${m.body}`;
}

/** The dev inbox: where you read sign-in codes locally, and see what every fake provider did. */
export function renderInbox(store: FakeStore): string {
  const messages = store.messages.map(
    (m) => `<tr>${cell(m.at)}${cell(m.channel)}${cell(m.to)}${cell(messageText(m))}</tr>`,
  );
  const charges = [...store.transactions.values()]
    .reverse()
    .map(
      (t) =>
        `<tr>${cell(t.createdAt)}${cell(t.reference)}${cell(t.channel)}${cell(t.requestedAmount)}${cell(t.amount)}${cell(t.status)}${cell(t.subaccount)}</tr>`,
    );
  const subaccounts = [...store.subaccounts.values()]
    .reverse()
    .map(
      (s) =>
        `<tr>${cell(s.at)}${cell(s.code)}${cell(s.businessName)}${cell(s.settlementBank)}${cell(`******${s.accountNumber.slice(-4)}`)}</tr>`,
    );
  const settlements = [...store.settlements]
    .reverse()
    .map(
      (s) =>
        `<tr>${cell(s.settledAt)}${cell(s.id)}${cell(s.subaccount)}${cell(s.totalAmount)}${cell(s.totalFees)}${cell(s.effectiveAmount)}</tr>`,
    );
  const checks = [...store.identityChecks.values()]
    .reverse()
    .map(
      (c) =>
        `<tr>${cell(c.createdAt)}${cell(c.checkId)}${cell(c.idType)}${cell(maskIdNumber(c.idNumber))}${cell(c.status)}</tr>`,
    );
  const webhooks = store.webhooks.map(
    (w) =>
      `<tr>${cell(w.at)}${cell(w.kind)}${cell(w.event)}${cell(w.url)}${cell(w.status ?? w.error)}</tr>`,
  );

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Fake providers inbox</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse;width:100%;margin-bottom:24px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}h2{margin-top:32px}</style></head>
<body><h1>Fake providers inbox</h1><p>What the platform sent through the fake providers. Refreshes every 5 seconds. Times are UTC.
Email goes to Mailpit (http://localhost:8025 by default).</p>
<h2>Messages: SMS, WhatsApp and push</h2>${table(['Time (UTC)', 'Channel', 'To', 'Message'], messages, 'No messages yet.')}
<h2>Payment charges</h2>${table(['Created (UTC)', 'Reference', 'Channel', 'Asked (pesewas)', 'Paid or asked (pesewas)', 'Status', 'Subaccount'], charges, 'No charges yet.')}
<h2>Subaccounts</h2>${table(['Created (UTC)', 'Code', 'Business', 'Bank', 'Account'], subaccounts, 'No subaccounts yet.')}
<h2>Settlements</h2>${table(['Settled (UTC)', 'Id', 'Subaccount', 'Gross (pesewas)', 'Fees (pesewas)', 'Net (pesewas)'], settlements, 'No settlements yet.')}
<h2>Identity checks</h2>${table(['Started (UTC)', 'Check', 'ID type', 'ID number', 'Status'], checks, 'No identity checks yet.')}
<h2>Webhooks delivered</h2>${table(['Time (UTC)', 'Provider', 'Event', 'URL', 'Result'], webhooks, 'No webhooks delivered yet.')}
</body></html>`;
}
