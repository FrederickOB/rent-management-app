#!/usr/bin/env node
// The month-end load test's verdict (M11 decision 7): reads what load/run-month-end.sh left in
// LOAD_OUT (k6-summary.json, report.json, checks.json, samples.jsonl), applies the pass criteria,
// and writes result.json and summary.md. Exits 1 when a criterion fails. Node built-ins only.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    out: { type: 'string' },
    'k6-status': { type: 'string', default: '0' },
    'drain-status': { type: 'string', default: '0' },
    'checks-status': { type: 'string', default: '0' },
    'drain-ms': { type: 'string', default: '0' },
    'run-ms': { type: 'string', default: '0' },
    'fixture-ms': { type: 'string', default: '0' },
    'run-started': { type: 'string' },
  },
});
const out = path.resolve(a.out);
const read = (name) => {
  const file = path.join(out, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};
const k6 = read('k6-summary.json');
const report = read('report.json');
const checks = read('checks.json');
const env = (name, fallback) => Number(process.env[name] ?? fallback);
const profile = {
  units: env('LOAD_UNITS', 5000),
  staff: env('LOAD_STAFF', 50),
  durationMin: env('LOAD_DURATION_MIN', 60),
  payments: env('LOAD_PAYMENTS', 2500),
  peakPayments: env('LOAD_PEAK_PAYMENTS', 1000),
  peakMin: env('LOAD_PEAK_MIN', 10),
  tenantPages: env('LOAD_TENANT_PAGES', 500),
};

const metric = (name, stat) => k6?.metrics?.[name]?.values?.[stat] ?? null;
const count = (name) => metric(name, 'count') ?? 0;
const trend = (name) => ({
  count: metric(name, 'count'),
  p50: metric(name, 'med'),
  p95: metric(name, 'p(95)'),
  max: metric(name, 'max'),
});
const companies = report?.companies ?? [];
const sum = (key) => companies.reduce((s, c) => s + Number(c[key] ?? 0), 0);
// The load company: the one that took the run's payments.
const load = [...companies].sort((x, y) => y.payments - x.payments)[0] ?? {};

// Queues drained within 15 minutes of the peak: the first sample after the peak's end with
// nothing waiting, or else the drain after the run.
const LIMIT_MS = 15 * 60_000;
let afterPeakMs = null;
if (report?.samples?.series && a['run-started']) {
  const peakEnd = Date.parse(a['run-started']) + profile.peakMin * 60_000;
  const empty = report.samples.series.find(
    (s) => Date.parse(s.at) >= peakEnd && Number(s.jobs) === 0 && Number(s.inbox) === 0,
  );
  if (empty) afterPeakMs = Date.parse(empty.at) - peakEnd;
}
const drainMs = Number(a['drain-ms']);
const drainedInTime =
  a['drain-status'] === '0' &&
  (afterPeakMs !== null ? afterPeakMs <= LIMIT_MS : drainMs <= LIMIT_MS);

const approved = count('payments_approved');
const criteria = [
  {
    id: 'no-5xx',
    text: 'No request fails with a 5xx (nor goes unanswered)',
    pass: count('server_errors') === 0 && count('request_errors') === 0,
    value: `${count('server_errors')} 5xx, ${count('request_errors')} unanswered`,
  },
  {
    id: 'no-duplicate-payments',
    text: 'No payment is duplicated',
    pass: sum('duplicatePayments') === 0 && sum('intentsSharingAPayment') === 0,
    value: `${sum('duplicatePayments')} duplicate references, ${sum('intentsSharingAPayment')} payments with two intents`,
  },
  {
    id: 'every-payment-posted',
    text: 'Every approved payment is posted once',
    pass: approved > 0 && Number(load.paymentsFromIntents ?? 0) === approved,
    value: `${approved} approved, ${load.paymentsFromIntents ?? 0} posted from their intents`,
  },
  {
    id: 'no-duplicate-receipts',
    text: 'No receipt is duplicated, and receipt numbers have no gaps',
    pass:
      sum('duplicateReceipts') === 0 &&
      sum('receiptNumberGaps') === 0 &&
      companies.every((c) => c.receiptsStartAtOne),
    value: `${sum('duplicateReceipts')} duplicates, ${sum('receiptNumberGaps')} gaps over ${sum('receipts')} receipts`,
  },
  {
    id: 'webhook-intake-p95',
    text: 'Webhook intake under 500 ms at p95, none refused',
    pass:
      (metric('webhook_intake_ms', 'p(95)') ?? Infinity) < 500 && count('webhook_failures') === 0,
    value: `p95 ${Math.round(metric('webhook_intake_ms', 'p(95)') ?? 0)} ms; ${count('webhook_failures')} refused or lost`,
  },
  {
    id: 'staff-reads-p95',
    text: 'Staff reads under 1.5 s at p95',
    pass: (metric('staff_read_ms', 'p(95)') ?? Infinity) < 1500,
    value: `p95 ${Math.round(metric('staff_read_ms', 'p(95)') ?? 0)} ms over ${count('staff_read_ms')} reads`,
  },
  {
    id: 'receipt-sent-p95',
    text: 'Payment to receipt sent under 1 minute at p95, every receipt sent',
    pass:
      (load.paymentToReceiptSentMs?.p95 ?? Infinity) < 60_000 &&
      Number(load.paymentToReceiptSentMs?.count ?? 0) >= approved,
    value: `p95 ${Math.round((load.paymentToReceiptSentMs?.p95 ?? 0) / 1000)} s; ${load.paymentToReceiptSentMs?.count ?? 0} of ${approved} sent`,
  },
  {
    id: 'queues-drain',
    text: 'The queues drain within 15 minutes of the peak',
    pass: drainedInTime,
    value:
      afterPeakMs !== null
        ? `empty ${Math.round(afterPeakMs / 1000)} s after the peak; ${Math.round(drainMs / 1000)} s after the run`
        : `${Math.round(drainMs / 1000)} s after the run`,
  },
  {
    id: 'nightly-checks',
    text: 'Every nightly ledger and audit check passes afterwards',
    pass: a['checks-status'] === '0' && checks?.failed === 0,
    value: checks ? `${checks.checks - checks.failed}/${checks.checks} passed` : 'not run',
  },
];

const audit = report?.samples?.auditChainHead ?? null;
const append = (report?.auditFunctions ?? []).find((f) => f.name === 'audit.append') ?? null;
const measured = {
  monthEndBalanceReads: trend('balance_read_ms'),
  dashboardReads: trend('dashboard_read_ms'),
  payPage: trend('pay_page_ms'),
  payStart: trend('pay_start_ms'),
  tenantPages: trend('tenant_page_ms'),
  webhookIntake: trend('webhook_intake_ms'),
  staffReads: trend('staff_read_ms'),
  staffByRead: Object.fromEntries(
    ['dashboard', 'invoices', 'tenants', 'tenant', 'lease_balance', 'receipts'].map((r) => [
      r,
      trend(`staff_${r}_ms`),
    ]),
  ),
  payStartRefusals: Object.fromEntries(
    Object.entries(k6?.metrics ?? {})
      .filter(([name]) => name.startsWith('pay_start_failed{'))
      .map(([name, m]) => [name.slice('pay_start_failed{'.length, -1), m.values?.count ?? 0]),
  ),
  staffRefused: count('staff_refused'),
  paymentToReceiptSent: load.paymentToReceiptSentMs ?? null,
  auditChainHead: audit && {
    ...audit,
    appendCalls: append?.calls ?? null,
    appendMeanMs: append?.meanMs ?? null,
  },
  queues: {
    maxJobsWaiting: report?.samples?.maxJobsWaiting ?? null,
    maxWebhooksWaiting: report?.samples?.maxWebhooksWaiting ?? null,
    drainAfterRunMs: drainMs,
    emptyAfterPeakMs: afterPeakMs,
  },
  maxLockWaiters: report?.samples?.maxLockWaiters ?? null,
  webhooks: report?.webhooks ?? [],
  intents: load.intents ?? {},
};
const passed = criteria.every((c) => c.pass);
const result = {
  at: new Date().toISOString(),
  database: report?.database ?? null,
  profile,
  timings: {
    fixtureMs: Number(a['fixture-ms']),
    runMs: Number(a['run-ms']),
    drainMs,
  },
  k6Exit: Number(a['k6-status']),
  passed,
  criteria,
  measured,
};
writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);

const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
const md = [
  '# Month-end load test',
  '',
  `- **When:** ${result.at}, on \`${result.database}\`.`,
  `- **Profile:** ${profile.units} units, ${profile.staff} staff, ${profile.payments} payments in ${profile.durationMin} minutes (${profile.peakPayments} in the first ${profile.peakMin}), ${profile.tenantPages} tenant pay pages.`,
  `- **Timings:** fixture ${Math.round(result.timings.fixtureMs / 1000)} s; run ${Math.round(result.timings.runMs / 1000)} s; drain after the run ${Math.round(drainMs / 1000)} s.`,
  `- **Verdict:** ${
    passed
      ? 'every criterion passed'
      : '**failed**: ' +
        criteria
          .filter((c) => !c.pass)
          .map((c) => c.id)
          .join(', ')
  }.`,
  '',
  '## Pass criteria (decision 7)',
  '',
  '| Criterion | Result | Measured |',
  '| --- | --- | --- |',
  ...criteria.map((c) => `| ${c.text} | ${c.pass ? 'pass' : '**fail**'} | ${c.value} |`),
  '',
  '## Also measured',
  '',
  '| What | p50 | p95 | max | n |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...[
    ['Month-end lease balance reads', measured.monthEndBalanceReads],
    ['Dashboard reads', measured.dashboardReads],
    ['Staff reads, all', measured.staffReads],
    ...Object.entries(measured.staffByRead).map(([read, t]) => [`  ${read.replace('_', ' ')}`, t]),
    ['Pay page (payers)', measured.payPage],
    ['Pay start (charge made)', measured.payStart],
    ['Tenant pay pages', measured.tenantPages],
    ['Webhook intake', measured.webhookIntake],
  ].map(
    ([label, t]) => `| ${label} | ${ms(t.p50)} | ${ms(t.p95)} | ${ms(t.max)} | ${t.count ?? 0} |`,
  ),
  `| Payment to receipt sent | ${ms(measured.paymentToReceiptSent?.p50)} | ${ms(measured.paymentToReceiptSent?.p95)} | ${ms(measured.paymentToReceiptSent?.max)} | ${measured.paymentToReceiptSent?.count ?? 0} |`,
  '',
  `- **Audit chain head contention:** ${
    audit
      ? `a writer waited on the chain head lock in ${audit.samplesWithAWaiter} of ${report.samples.count} samples (${(audit.shareOfSamples * 100).toFixed(1)}%), at most ${audit.maxWaiting} at once; audit.append ran ${append?.calls ?? '—'} times at ${append?.meanMs?.toFixed?.(2) ?? '—'} ms on average.`
      : 'not sampled.'
  }`,
  `- **Queues:** at most ${measured.queues.maxJobsWaiting ?? '—'} jobs and ${measured.queues.maxWebhooksWaiting ?? '—'} webhooks waiting at once; most lock waiters at once ${measured.maxLockWaiters ?? '—'}.`,
  `- **Staff reads refused by policy** (caretakers outside their property): ${measured.staffRefused}.`,
  `- **Pay starts refused:** ${count('pay_start_failed')}${
    Object.keys(measured.payStartRefusals).length
      ? ` (${Object.entries(measured.payStartRefusals)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')})`
      : ''
  }; see logs/k6.log for the first codes.`,
  `- **Payment intents of the run:** ${
    Object.entries(measured.intents)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || '—'
  }.`,
  '',
  'CI runners are small: these numbers are a regression check, not capacity. Production is measured again in M12.',
  '',
];
writeFileSync(path.join(out, 'summary.md'), md.join('\n'));
console.log(md.join('\n'));
process.exit(passed ? 0 : 1);
