// The month-end load test (M11 decision 7; load/README.md). Run by load/run-month-end.sh inside the
// pinned grafana/k6 image, against a stack of its own on a scratch database. Three scenarios at once:
//
// - payments: LOAD_PAYMENTS (2,500) tenants pay in LOAD_DURATION_MIN (60) minutes, LOAD_PEAK_PAYMENTS
//   (1,000) of them in the first LOAD_PEAK_MIN (10). Each takes the full path: the pay page (links),
//   the MoMo charge (links, api, the fake provider), the payer approving on the phone (the fake),
//   which sends the signed webhook to the api, then the worker's verify, posting, receipt and SMS;
//   the tenant's page follows the payment.
// - staff: LOAD_STAFF_VUS (every fixture session, 50) staff work the dashboard, invoice, tenant and
//   receipt lists, tenant pages and lease balances, with a few seconds' thought between reads.
// - tenantPages: LOAD_TENANT_PAGES (500) other tenants open their pay page over the run.
//
// The pass criteria are thresholds where k6 can measure them (no 5xx; webhook intake p95 < 500 ms;
// staff reads p95 < 1.5 s); the rest are measured in the database afterwards by the runner.
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const env = (name, fallback) =>
  __ENV[name] === undefined || __ENV[name] === '' ? fallback : __ENV[name];
const API = env('API_URL', 'http://host.docker.internal:3780');
const LINKS = env('LINKS_URL', 'http://host.docker.internal:3782');
const FAKE = env('FAKE_URL', 'http://host.docker.internal:4180');
const OUT = env('OUT', '/out');
const DURATION_MIN = Number(env('LOAD_DURATION_MIN', 60));
const PAYMENTS = Number(env('LOAD_PAYMENTS', 2500));
const PEAK_PAYMENTS = Number(env('LOAD_PEAK_PAYMENTS', 1000));
const PEAK_MIN = Number(env('LOAD_PEAK_MIN', 10));
const TENANT_PAGES = Number(env('LOAD_TENANT_PAGES', 500));
const THINK_S = Number(env('LOAD_THINK_S', 3));

const fixture = JSON.parse(open(env('FIXTURE', '/out/fixture.json')));
const tenants = new SharedArray('tenants', () => fixture.tenants);
const staff = new SharedArray('staff', () => fixture.staff);
const STAFF_VUS = Number(env('LOAD_STAFF_VUS', staff.length));
// The leases billed here from their start (up to 11 months): the month-end balance reads' worst case.
const withHistory = new SharedArray('history', () => fixture.tenants.filter((t) => t.history));
const PAYERS = Math.min(PAYMENTS, tenants.length);

const serverErrors = new Counter('server_errors');
const requestErrors = new Counter('request_errors');
const webhookFailures = new Counter('webhook_failures');
const payStartFailed = new Counter('pay_start_failed');
const paymentsApproved = new Counter('payments_approved');
const staffRefused = new Counter('staff_refused');
const webhookIntake = new Trend('webhook_intake_ms', true);
const payPage = new Trend('pay_page_ms', true);
const payStart = new Trend('pay_start_ms', true);
const staffRead = new Trend('staff_read_ms', true);
const balanceRead = new Trend('balance_read_ms', true);
const dashboardRead = new Trend('dashboard_read_ms', true);
const tenantPage = new Trend('tenant_page_ms', true);
const STAFF_READS = ['dashboard', 'invoices', 'tenants', 'tenant', 'lease_balance', 'receipts'];
const staffByRead = Object.fromEntries(
  STAFF_READS.map((r) => [r, new Trend(`staff_${r}_ms`, true)]),
);

const peakRate = Math.max(1, Math.round(PEAK_PAYMENTS / PEAK_MIN));
const restMinutes = Math.max(1, DURATION_MIN - PEAK_MIN);
const restRate = Math.max(1, Math.round((PAYMENTS - PEAK_PAYMENTS) / restMinutes));

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  scenarios: {
    payments: {
      executor: 'ramping-arrival-rate',
      exec: 'pay',
      timeUnit: '1m',
      startRate: peakRate,
      preAllocatedVUs: Math.min(200, Math.max(10, Math.ceil(peakRate / 6))),
      maxVUs: 400,
      stages: [
        { duration: `${PEAK_MIN * 60}s`, target: peakRate },
        { duration: '10s', target: restRate },
        { duration: `${restMinutes * 60 - 10}s`, target: restRate },
      ],
    },
    staff: {
      executor: 'constant-vus',
      exec: 'staffWork',
      vus: STAFF_VUS,
      duration: `${DURATION_MIN * 60}s`,
    },
    tenantPages: {
      executor: 'constant-arrival-rate',
      exec: 'openPage',
      rate: TENANT_PAGES,
      timeUnit: `${DURATION_MIN * 60}s`,
      duration: `${DURATION_MIN * 60}s`,
      preAllocatedVUs: 5,
      maxVUs: 50,
    },
  },
  thresholds: {
    server_errors: ['count==0'],
    request_errors: ['count==0'],
    webhook_failures: ['count==0'],
    webhook_intake_ms: ['p(95)<500'],
    staff_read_ms: ['p(95)<1500'],
  },
};

/** Counts a 5xx, or no answer at all, and times the request into `trend`. */
const record = (res, trend) => {
  if (res.status >= 500) serverErrors.add(1);
  if (res.status === 0) requestErrors.add(1);
  if (trend) trend.add(res.timings.duration);
  return res;
};

/** A different address per tenant, as their phones are (links reads it from CLIENT_IP_HEADER). */
const addressOf = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

let warned = 0;

const submissionId = () =>
  `load-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`.padEnd(20, '0');

export function pay() {
  const i = exec.scenario.iterationInTest;
  if (i >= PAYERS) return;
  const t = tenants[i];
  const headers = { 'x-load-client-ip': addressOf(i), 'user-agent': 'rent-load-k6 (tenant)' };
  record(http.get(`${LINKS}/p/${t.token}`, { headers, tags: { name: 'pay_page' } }), payPage);
  const started = record(
    http.post(
      `${LINKS}/p/${t.token}/pay`,
      {
        method: 'momo-mtn',
        amount: t.amountText,
        momoPhone: t.momoPhone,
        submissionId: submissionId(),
      },
      { headers, redirects: 0, tags: { name: 'pay_start' } },
    ),
    payStart,
  );
  const location = started.headers.Location || started.headers.location || '';
  const match = /[?&]intent=([0-9a-f-]{36})/.exec(location);
  if (started.status !== 303 || !match) {
    // Why, as the app's own code (`?error=CODE` on the redirect); never the token.
    const code = (/[?&]error=([A-Z_]+)/.exec(location) || [null, `HTTP_${started.status}`])[1];
    payStartFailed.add(1, { reason: code });
    if (warned < 5) {
      warned += 1;
      console.warn(`pay start refused: ${code}`);
    }
    return;
  }
  const intentId = match[1];
  // The payer approves on the phone: the fake provider sends its webhook to the api and answers
  // with how the api took it.
  const approved = record(
    http.post(
      `${FAKE}/payments/_test/charges/pi-${intentId.replace(/-/g, '').toLowerCase()}`,
      JSON.stringify({ status: 'success' }),
      { headers: { 'content-type': 'application/json' }, tags: { name: 'provider_approve' } },
    ),
  );
  let delivery = null;
  try {
    delivery = approved.json('delivery');
  } catch (_) {
    delivery = null;
  }
  if (approved.status === 200) paymentsApproved.add(1);
  if (!delivery || delivery.error || !(delivery.status >= 200 && delivery.status < 300)) {
    webhookFailures.add(1);
    if (delivery && delivery.status >= 500) serverErrors.add(1);
  } else webhookIntake.add(delivery.ms);
  // The tenant's page follows the payment, as it refreshes itself.
  sleep(3);
  record(
    http.get(`${LINKS}/p/${t.token}?intent=${intentId}`, { headers, tags: { name: 'pay_follow' } }),
  );
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
export function staffWork() {
  const me = staff[(exec.vu.idInTest - 1) % staff.length];
  const t = pick(tenants);
  const roll = Math.random();
  const h = withHistory.length > 0 ? pick(withHistory) : t;
  const [read, path] =
    roll < 0.2
      ? ['dashboard', '/dashboard']
      : roll < 0.4
        ? ['invoices', `/invoices?limit=100&dueFrom=${fixture.today}`]
        : roll < 0.5
          ? ['tenants', '/tenants?withActiveLease=true']
          : roll < 0.65
            ? ['tenant', `/tenants/${t.tenantId}`]
            : roll < 0.9
              ? ['lease_balance', `/leases/${h.leaseId}/billing`]
              : ['receipts', '/receipts?limit=100'];
  const res = http.get(`${API}${path}`, {
    headers: { cookie: me.cookie },
    tags: { name: `staff_${read}`, kind: 'staff' },
  });
  record(res, staffRead);
  staffByRead[read].add(res.timings.duration);
  // Refused by policy (a caretaker outside their property) is not timed as a read of the data.
  if (res.status < 400) {
    if (read === 'dashboard') dashboardRead.add(res.timings.duration);
    if (read === 'lease_balance') balanceRead.add(res.timings.duration);
  }
  // A caretaker sees only their property: a refusal is the policy working, not a failure.
  if (res.status >= 400 && res.status < 500) staffRefused.add(1, { role: me.role });
  check(res, { 'staff read answered': (r) => r.status < 500 });
  sleep(THINK_S * (0.5 + Math.random()));
}

export function openPage() {
  const spare = tenants.length - PAYERS;
  if (spare <= 0) return;
  const i = PAYERS + (exec.scenario.iterationInTest % spare);
  const t = tenants[i];
  record(
    http.get(`${LINKS}/p/${t.token}`, {
      headers: { 'x-load-client-ip': addressOf(i), 'user-agent': 'rent-load-k6 (tenant)' },
      tags: { name: 'tenant_page' },
    }),
    tenantPage,
  );
}

export function handleSummary(data) {
  const m = (name, stat) => {
    const metric = data.metrics[name];
    return metric && metric.values ? metric.values[stat] : null;
  };
  const line = (label, name) =>
    `  ${label.padEnd(26)} p95 ${String(Math.round(m(name, 'p(95)') ?? 0)).padStart(6)} ms  (n ${m(name, 'count') ?? 0})`;
  const text = [
    'month-end load (k6):',
    `  payments approved          ${m('payments_approved', 'count') ?? 0} (start failures ${m('pay_start_failed', 'count') ?? 0})`,
    `  server errors (5xx)        ${m('server_errors', 'count') ?? 0}; no answer ${m('request_errors', 'count') ?? 0}; webhook failures ${m('webhook_failures', 'count') ?? 0}`,
    line('webhook intake', 'webhook_intake_ms'),
    line('staff reads', 'staff_read_ms'),
    line('  of which lease balances', 'balance_read_ms'),
    line('  of which dashboards', 'dashboard_read_ms'),
    ...STAFF_READS.map((r) => line(`  ${r.replace('_', ' ')}`, `staff_${r}_ms`)),
    line('pay page (payers)', 'pay_page_ms'),
    line('pay start', 'pay_start_ms'),
    line('tenant pay pages', 'tenant_page_ms'),
    '',
  ].join('\n');
  return { [`${OUT}/k6-summary.json`]: JSON.stringify(data, null, 2), stdout: text };
}
