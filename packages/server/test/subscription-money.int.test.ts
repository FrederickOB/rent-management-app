import { sql, withSystem } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { subscriptionPostingKeys } from '@rent/domain/ledger';
import { money, multiplyFraction } from '@rent/domain/money';
import {
  daysInMonth,
  monthBounds,
  monthOf,
  nextMonth,
  previousMonth,
  shiftMonth,
  trialEndsOn,
} from '@rent/domain/subscription';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { ReconciliationService } from '../src/payments/reconciliation.service';
import { SubscriptionBillingService } from '../src/subscription/billing.service';
import { SubscriptionCreditNotesService } from '../src/subscription/credit-notes.service';
import { SubscriptionLifecycleService } from '../src/subscription/lifecycle.service';
import { withPlatform } from '../src/subscription/platform';
import { SubscriptionService } from '../src/subscription/subscription.service';
import { asSuperuser, startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { platform } from './support/messaging';
import { deliverWebhook, paymentsServices, type PaymentsServices } from './support/payments';
import {
  openInvoice,
  subscribe,
  subscriptionPaymentsServices,
  type SubscriptionPaymentsServices,
} from './support/subscription-payments';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * M10 subscription money, from the review (BE-9, BE-13, BE-14 and BE-26), on the services with
 * real PostgreSQL and RLS. Billing is on from {@link ACTIVATION} (founder answer Q1), turned on as
 * the platform's system path:
 * - P26's revenue falls in the month an invoice covers;
 * - the snapshot and invoice jobs catch up every ended month since the last invoice (at most
 *   three), as of the job's date, in the subscriber's own time zone;
 * - the invoice job draws prepaid credit; an annual-rate invoice paid entirely by a draw;
 *   concurrent verification of one reference posts once; an upgrade's two tier spans; the first
 *   month after a trial; the final month after a cancellation, and nothing after it;
 * - the platform's provider clearing (1050) is compared with the provider, through payments,
 *   chargebacks and payouts, each line naming its provider.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let sp: SubscriptionPaymentsServices;
let billing: SubscriptionBillingService;
let lifecycle: SubscriptionLifecycleService;
let subscriptions: SubscriptionService;
let credits: SubscriptionCreditNotesService;
let admin: Awaited<ReturnType<typeof platform>>;
let today: string;
let month: string;
let last: string;

/** The day billing goes on in this database: before every month the tests bill. */
const ACTIVATION = '2026-01-01';

type Company = Awaited<ReturnType<typeof moneyCompany>>;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));
const prorated = (minor: number, days: number, inMonth: number) =>
  multiplyFraction(money(minor), [days], [inMonth]).amountMinor;

async function rows<T>(statement: string, values: unknown[] = []): Promise<T[]> {
  return (await asSuperuser(ctx, statement, values)) as T[];
}

/** A company created `days` ago (or on `createdOn`), on `plan`, its subscription not started. */
async function oldCompany(
  name: string,
  options: { days?: number; createdOn?: string; plan?: string; timeZone?: string } = {},
): Promise<Company> {
  const c = await moneyCompany(ctx, s, 'agency', name);
  await asSuperuser(
    ctx,
    `update company set created_at = coalesce($4::timestamptz, now() - make_interval(days => $2)),
       plan = $3, time_zone = $5 where id = $1`,
    [
      c.companyId,
      options.days ?? 120,
      options.plan ?? 'growth',
      options.createdOn ? `${options.createdOn}T12:00:00Z` : null,
      options.timeZone ?? 'Africa/Accra',
    ],
  );
  return c;
}

/** Units let from `starts`, one unit each (self-contained), as billing sees them. */
async function letUnits(c: Company, part: string, starts: readonly string[]) {
  const owner = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${part} owner` })
  ).id;
  const { units } = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId: owner,
    units: [{ unitType: 'apartment', count: starts.length, bedrooms: 1 }],
  });
  for (const [i, unitId] of Object.values(units).entries()) {
    const start = starts[i]!;
    const { tenant } = await s.tenants.create(c.manager, {
      kind: 'individual',
      displayName: `${part} tenant ${i}`,
    });
    await billedLease(ctx, s, b, c.manager, {
      unitId,
      tenantId: tenant.id,
      startDate: start,
      endDate: plusDays(start, 364),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      depositMinor: null,
      signedOn: start < today ? start : today,
      billingStartDate: start,
    });
  }
  await s.lifecycle.runTransitions(c.companyId, today);
}

/** Runs `fn` with the clock at `at`, then puts it back. */
async function at<T>(instant: string, fn: () => Promise<T>): Promise<T> {
  const before = ctx.clock.now();
  ctx.clock.set(new Date(instant));
  try {
    return await fn();
  } finally {
    ctx.clock.set(before);
  }
}

async function invoicesOf(companyId: string) {
  return rows<{ id: string; number: string; month: string; status: string; total_minor: number }>(
    `select id, number, month, status, total_minor::bigint as total_minor from subscription_invoice
      where subscriber_company_id = $1 order by month`,
    [companyId],
  );
}

async function linesOf(invoiceId: string) {
  return rows<{
    kind: string;
    tier: string | null;
    days: number | null;
    days_in_month: number | null;
    rate_bps: number | null;
    description: string;
    amount_minor: number;
  }>(
    `select kind, tier, days, days_in_month, rate_bps, description, amount_minor::bigint as amount_minor
       from subscription_invoice_line where invoice_id = $1 order by line_no`,
    [invoiceId],
  );
}

/** An entry by its key: its dates and lines (with each line's provider). */
async function entry(key: string) {
  const lines = await rows<{
    value_date: string;
    accounting_date: string;
    account_code: string;
    amount: number;
    provider: string | null;
    invoice_line_id: string | null;
    book_kind: string;
  }>(
    `select e.value_date::text, e.accounting_date::text, l.account_code, l.amount_minor::bigint as amount,
            l.provider, l.invoice_line_id, b.kind as book_kind
       from journal_entry e
       join journal_line l on l.company_id = e.company_id and l.entry_id = e.id
       join book b on b.company_id = l.company_id and b.id = l.book_id
      where e.idempotency_key = $1 order by l.line_no`,
    [key],
  );
  return {
    valueDate: lines[0]?.value_date ?? null,
    accountingDate: lines[0]?.accounting_date ?? null,
    lines: lines.map((l) => ({
      account: l.account_code,
      amount: Number(l.amount),
      provider: l.provider,
      invoiceId: l.invoice_line_id,
      book: l.book_kind,
    })),
  };
}

async function creditOf(companyId: string) {
  return withPlatform(ctx.database, {}, (tx) => sp.core.creditMinor(tx, companyId));
}

/** Pays every open invoice by card; the provider confirms and the webhook posts it. */
async function payByCard(c: Company, feesMinor = 0) {
  const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
  const webhook = await p.primary.completeCharge(started.reference, {
    status: 'success',
    feesMinor,
  });
  expect((await deliverWebhook(ctx, p, 'paystack', webhook!)).outcome).toBe('posted');
  return started;
}

/** The platform book's provider clearing (1050) for a provider, from the journal. */
async function platformClearing(provider: string) {
  const [row] = await rows<{ total: string }>(
    `select coalesce(sum(l.amount_minor), 0)::bigint as total from journal_line l
       join book b on b.company_id = l.company_id and b.id = l.book_id
      where b.kind = 'platform' and l.account_code = '1050' and l.provider = $1`,
    [provider],
  );
  return Number(row!.total);
}

const clearingAlerts = () => p.alerts.filter((a) => a.code === 'subscription.clearing_difference');

beforeAll(async () => {
  ctx = await startServerTest();
  s = tenancyServices(ctx);
  b = billingServices(ctx, s);
  p = paymentsServices(ctx, s, b);
  sp = subscriptionPaymentsServices(ctx, s, b, p);
  billing = new SubscriptionBillingService(
    ctx.database,
    sp.core,
    b.posting,
    s.documents,
    s.rules,
    s.policy,
  );
  lifecycle = new SubscriptionLifecycleService(ctx.database, sp.core, s.policy, b.posting);
  subscriptions = new SubscriptionService(
    ctx.database,
    sp.core,
    billing,
    s.policy,
    s.rules,
    s.documents,
  );
  credits = new SubscriptionCreditNotesService(
    ctx.database,
    sp.core,
    b.posting,
    s.documents,
    s.policy,
  );
  admin = await platform(ctx);
  // Founder answer Q1: nothing is billed until a platform admin turns billing on (here, the
  // platform's system path, as the seed does).
  await withSystem(ctx.database, {}, (tx) =>
    tx.execute(sql`select app.turn_on_billing(${ACTIVATION}::date, 'M10 review money tests')`),
  );
  today = isoNow(ctx.clock, 'Africa/Accra');
  month = monthOf(today);
  last = previousMonth(month);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

describe('PB-07 P26 revenue falls in the month the invoice covers (review BE-9)', () => {
  it('dates the invoice entry the last day of the billed month, its accounting date by the usual rules', async () => {
    const c = await oldCompany('Revenue Month Agency');
    const issued = await billing.invoice(c.companyId);
    expect(issued).not.toBeNull();
    const posted = await entry(subscriptionPostingKeys.invoice(issued!.id));
    expect(posted.valueDate).toBe(monthBounds(last).last);
    // Nothing is locked in the platform book, so the accounting date is the value date.
    expect(posted.accountingDate).toBe(monthBounds(last).last);
    expect(posted.lines.map((l) => [l.account, l.amount, l.book])).toEqual([
      ['1100', issued!.totalMinor, 'platform'],
      ['4600', -issued!.totalMinor, 'platform'],
    ]);
    // The invoice itself is issued in the month after (decision 2: in arrears).
    const [invoice] = await rows<{ issued_on: string }>(
      'select issued_on::text from subscription_invoice where id = $1',
      [issued!.id],
    );
    expect(invoice!.issued_on).toBe(today);
  });
});

describe('PB-02 and PB-07 the jobs catch up missed months (review BE-13)', () => {
  it('bills every month ended since the last invoice, oldest first, once', async () => {
    const c = await oldCompany('Catch Up Agency', { days: 300 });
    const old = await billing.invoice(c.companyId, { month: shiftMonth(month, -4) });
    expect(old).not.toBeNull();
    // The last invoice is for four months ago: the three months since are due.
    expect((await billing.dueMonths(c.companyId))!.months).toEqual([
      shiftMonth(month, -3),
      shiftMonth(month, -2),
      last,
    ]);
    const taken = await billing.snapshotDue(c.companyId);
    expect(taken.map((t) => t.month)).toEqual([shiftMonth(month, -3), shiftMonth(month, -2), last]);
    // Taken once: the next run (before the invoice job) takes none again.
    expect(await billing.snapshotDue(c.companyId)).toEqual([]);
    const issued = await billing.invoiceDue(c.companyId);
    expect(issued).toHaveLength(3);
    const all = await invoicesOf(c.companyId);
    expect(all.map((i) => i.month)).toEqual([
      shiftMonth(month, -4),
      shiftMonth(month, -3),
      shiftMonth(month, -2),
      last,
    ]);
    // Numbered in month order (the same year's numbers rise with the months).
    const numbers = all.slice(1).map((i) => i.number);
    expect([...numbers].sort()).toEqual(numbers);
    expect(issued.map((i) => i.id)).toEqual(all.slice(1).map((i) => i.id));
    // Each P26 entry is dated its own month's last day.
    for (const invoice of all.slice(1))
      expect((await entry(subscriptionPostingKeys.invoice(invoice.id))).valueDate).toBe(
        monthBounds(invoice.month).last,
      );
    // Run again: nothing new.
    expect(await billing.invoiceDue(c.companyId)).toEqual([]);
    expect(await billing.snapshotDue(c.companyId)).toEqual([]);
    expect(await invoicesOf(c.companyId)).toHaveLength(4);
  });

  it('goes back at most three months', async () => {
    const c = await oldCompany('Long Gap Agency', { days: 300 });
    await billing.invoice(c.companyId, { month: shiftMonth(month, -6) });
    const issued = await billing.invoiceDue(c.companyId);
    expect(issued).toHaveLength(3);
    expect((await invoicesOf(c.companyId)).map((i) => i.month)).toEqual([
      shiftMonth(month, -6),
      shiftMonth(month, -3),
      shiftMonth(month, -2),
      last,
    ]);
  });

  it('honours the job’s date: a run for an earlier day bills only what had ended by then', async () => {
    const c = await oldCompany('Job Date Agency', { days: 300 });
    const jobDay = monthBounds(last).last;
    expect((await billing.dueMonths(c.companyId, { date: jobDay }))!).toEqual({
      asOf: jobDay,
      months: [shiftMonth(month, -4), shiftMonth(month, -3), shiftMonth(month, -2)],
    });
    expect((await billing.snapshotDue(c.companyId, { date: jobDay })).map((t) => t.month)).toEqual([
      shiftMonth(month, -4),
      shiftMonth(month, -3),
      shiftMonth(month, -2),
    ]);
    const early = await billing.invoiceDue(c.companyId, { date: jobDay });
    expect(early).toHaveLength(3);
    expect((await invoicesOf(c.companyId)).map((i) => i.month)).not.toContain(last);
    // A date after today in the company's zone counts as today.
    const later = await billing.invoiceDue(c.companyId, { date: plusDays(today, 3) });
    expect(later).toHaveLength(1);
    expect((await invoicesOf(c.companyId)).at(-1)!.month).toBe(last);
  });

  it('works out the ended month in the company’s own time zone (Europe/London near midnight)', async () => {
    // 23:30 UTC on 31 July 2026 is 00:30 on 1 August in London (BST) and still 31 July in Accra.
    const instant = '2026-07-31T23:30:00Z';
    const london = await oldCompany('London Agency', {
      createdOn: '2026-01-01',
      timeZone: 'Europe/London',
    });
    const accra = await oldCompany('Accra Agency', { createdOn: '2026-01-01' });
    await at(instant, async () => {
      for (const c of [london, accra])
        expect(await billing.invoice(c.companyId, { month: '2026-06' })).not.toBeNull();
      // London's July has ended; Accra's has not.
      expect(await billing.dueMonths(london.companyId)).toEqual({
        asOf: '2026-08-01',
        months: ['2026-07'],
      });
      expect(await billing.dueMonths(accra.companyId)).toEqual({ asOf: '2026-07-31', months: [] });
      // The run fanned out for 31 July bills nothing more, even in London.
      expect(await billing.invoiceDue(london.companyId, { date: '2026-07-31' })).toEqual([]);
      // The run for 1 August bills London's July, and not Accra's, whose month has not ended.
      const july = await billing.invoiceDue(london.companyId, { date: '2026-08-01' });
      expect(july).toHaveLength(1);
      expect(await billing.invoiceDue(accra.companyId, { date: '2026-08-01' })).toEqual([]);
      const [invoice] = await rows<{ month: string; issued_on: string }>(
        'select month, issued_on::text from subscription_invoice where id = $1',
        [july[0]!.id],
      );
      expect(invoice).toEqual({ month: '2026-07', issued_on: '2026-08-01' });
      expect((await entry(subscriptionPostingKeys.invoice(july[0]!.id))).valueDate).toBe(
        '2026-07-31',
      );
    });
    expect((await invoicesOf(accra.companyId)).map((i) => i.month)).toEqual(['2026-06']);
  });
});

describe('PB-05 and PB-07 prepaid credit drawn by the invoice job (review BE-14)', () => {
  it('draws credit a credit note left onto the next invoice; the shortfall stays owed', async () => {
    const c = await oldCompany('Credit Draw Agency', { days: 200 });
    const first = await billing.invoice(c.companyId, { month: shiftMonth(month, -2) });
    expect(first!.totalMinor).toBe(15_000);
    await payByCard(c);
    // A platform admin credits part of the paid invoice: it becomes prepaid credit (2020).
    await credits.credit(admin, c.companyId, first!.id, {
      amountMinor: 5_000,
      reason: 'Goodwill for an outage',
    });
    expect(await creditOf(c.companyId)).toBe(5_000);

    const issued = await billing.invoiceDue(c.companyId);
    expect(issued).toHaveLength(1);
    const next = issued[0]!;
    expect(next.totalMinor).toBe(15_000);
    const allocations = await rows<{ source: string; payment_id: string | null; amount: number }>(
      `select source, payment_id, amount_minor::bigint as amount from subscription_allocation
        where invoice_id = $1`,
      [next.id],
    );
    expect(allocations).toEqual([{ source: 'prepaid', payment_id: null, amount: 5_000 }]);
    const draw = await entry(subscriptionPostingKeys.prepaidDraw(next.id));
    expect(draw.valueDate).toBe(today);
    expect(draw.lines.map((l) => [l.account, l.amount, l.invoiceId])).toEqual([
      ['2020', 5_000, next.id],
      ['1100', -5_000, next.id],
    ]);
    const open = await withPlatform(ctx.database, {}, (tx) =>
      sp.core.openInvoices(tx, c.companyId),
    );
    expect(open.map((i) => [i.id, i.outstandingMinor])).toEqual([[next.id, 10_000]]);
    expect(await creditOf(c.companyId)).toBe(0);
    expect(await sp.subledger.check()).toMatchObject({ mismatches: [] });
  });

  it('the nightly check counts what a credit note cleared of an open invoice (BE-6)', async () => {
    const c = await oldCompany('Credited Open Agency', { days: 200 });
    const invoice = await billing.invoice(c.companyId, { month: shiftMonth(month, -2) });
    await credits.credit(admin, c.companyId, invoice!.id, {
      amountMinor: 4_000,
      reason: 'Billed for a unit let late',
    });
    const open = await withPlatform(ctx.database, {}, (tx) =>
      sp.core.openInvoices(tx, c.companyId),
    );
    expect(open.map((i) => [i.id, i.outstandingMinor])).toEqual([[invoice!.id, 11_000]]);
    const result = await sp.subledger.check({ alert: false });
    expect(result.mismatches.filter((m) => m.subject === invoice!.id)).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });

  it('★ bills a month of a paid year at the annual rate, paid entirely from the prepaid credit', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Annual Draw Agency');
    await subscribe(ctx, sp, c.companyId);
    await letUnits(c, 'AND', [plusDays(today, -40), plusDays(today, -40)]);
    const started = await sp.payments.pay(c.admin, { purpose: 'annual', channel: 'card' });
    const webhook = await p.primary.completeCharge(started.reference, { status: 'success' });
    expect((await deliverWebhook(ctx, p, 'paystack', webhook!)).outcome).toBe('posted');
    const paid = started.amountMinor;
    expect(await creditOf(c.companyId)).toBe(paid);

    // This month ends; on the 1st of the next, the invoice job bills it.
    const firstOfNext = monthBounds(nextMonth(month)).first;
    const issued = await at(`${firstOfNext}T10:00:00Z`, () => billing.invoiceDue(c.companyId));
    expect(issued).toHaveLength(1);
    const invoice = issued[0]!;
    const [row] = await rows<{ month: string; status: string; issued_on: string }>(
      'select month, status, issued_on::text from subscription_invoice where id = $1',
      [invoice.id],
    );
    expect(row).toEqual({ month, status: 'paid', issued_on: firstOfNext });
    // Discounted units while the paid term runs (decision 7), from the day it started.
    const lines = await linesOf(invoice.id);
    const units = lines.filter((l) => l.kind === 'units');
    expect(units.length).toBeGreaterThan(0);
    for (const line of units) {
      expect(line.rate_bps).toBe(1_000);
      expect(line.description).toContain('annual discount');
      expect(line.days).toBe(Number(monthBounds(month).last.slice(8)) - Number(today.slice(8)) + 1);
    }
    // Paid entirely by the draw: one prepaid allocation of the whole total.
    const allocations = await rows<{ source: string; amount: number }>(
      'select source, amount_minor::bigint as amount from subscription_allocation where invoice_id = $1',
      [invoice.id],
    );
    expect(allocations).toEqual([{ source: 'prepaid', amount: invoice.totalMinor }]);
    expect((await entry(subscriptionPostingKeys.prepaidDraw(invoice.id))).valueDate).toBe(
      firstOfNext,
    );
    expect((await entry(subscriptionPostingKeys.invoice(invoice.id))).valueDate).toBe(
      monthBounds(month).last,
    );
    expect(await creditOf(c.companyId)).toBe(paid - invoice.totalMinor);
    expect(await sp.subledger.check()).toMatchObject({ mismatches: [] });
  });
});

describe('PB-07 one reference verified at once by several callers posts once (review BE-14)', () => {
  it('posts the payment once, with one receipt, whatever the race', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Race Agency');
    await subscribe(ctx, sp, c.companyId);
    await openInvoice(ctx, b.posting, c.companyId, {
      month: last,
      totalMinor: 12_345,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
    await p.primary.completeCharge(started.reference, { status: 'success' });
    const outcomes = await Promise.all(
      [1, 2, 3, 4, 5].map(() => sp.payments.processReference('paystack', started.reference)),
    );
    expect(outcomes.filter((o) => o === 'posted')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already_posted')).toHaveLength(4);
    expect(
      await rows(`select id from journal_entry where idempotency_key = $1`, [
        subscriptionPostingKeys.payment(started.id),
      ]),
    ).toHaveLength(1);
    expect(
      await rows('select id from subscription_receipt where payment_id = $1', [started.id]),
    ).toHaveLength(1);
    expect(
      await rows('select id from subscription_allocation where payment_id = $1', [started.id]),
    ).toHaveLength(1);
  });
});

describe('PB-05 an upgrade’s month is billed per tier span (review BE-14)', () => {
  it('prices each tier for its days, with its own prorated minimum', async () => {
    const c = await oldCompany('Upgrade Agency', { plan: 'starter' });
    const fifteenth = `${last}-15`;
    await at(`${fifteenth}T10:00:00Z`, () => subscriptions.changeTier(c.admin, 'growth'));
    const issued = await billing.invoice(c.companyId);
    const inMonth = daysInMonth(last);
    const lines = await linesOf(issued!.id);
    expect(
      lines.map((l) => [l.kind, l.tier, l.days, l.days_in_month, Number(l.amount_minor)]),
    ).toEqual([
      ['minimum', 'starter', 14, inMonth, prorated(5_000, 14, inMonth)],
      ['minimum', 'growth', inMonth - 14, inMonth, prorated(15_000, inMonth - 14, inMonth)],
    ]);
    expect(issued!.totalMinor).toBe(
      prorated(5_000, 14, inMonth) + prorated(15_000, inMonth - 14, inMonth),
    );
  });
});

describe('PB-08 the first month after a trial (review BE-14)', () => {
  it('bills from the day after the trial, and the subscription becomes active', async () => {
    const createdOn = plusDays(monthBounds(last).first, -20);
    const c = await oldCompany('After Trial Agency', { createdOn });
    const trialLast = trialEndsOn(createdOn, 30);
    expect(trialLast.slice(0, 7)).toBe(last);
    // Started during its trial, as the lifecycle job starts it the day after the company is made.
    const started = await at(`${plusDays(createdOn, 1)}T10:00:00Z`, () =>
      lifecycle.daily(c.companyId),
    );
    expect(started).toMatchObject({ status: 'trialing' });
    const issued = await billing.invoiceDue(c.companyId);
    // The month before was all trial: only last month is billed.
    expect(issued).toHaveLength(1);
    const inMonth = daysInMonth(last);
    const days = inMonth - Number(trialLast.slice(8));
    const lines = await linesOf(issued[0]!.id);
    expect(lines.map((l) => [l.kind, l.tier, l.days, Number(l.amount_minor)])).toEqual([
      ['minimum', 'growth', days, prorated(15_000, days, inMonth)],
    ]);
    const [sub] = await rows<{ status: string; trial_ends_on: string }>(
      'select status, trial_ends_on::text from subscription where subscriber_company_id = $1',
      [c.companyId],
    );
    expect(sub).toEqual({ status: 'active', trial_ends_on: trialLast });
    expect(
      await rows(
        `select 1 from subscription_event where subscriber_company_id = $1 and kind = 'status_changed'
            and status_from = 'trialing' and status_to = 'active'`,
        [c.companyId],
      ),
    ).toHaveLength(1);
  });
});

describe('PB-10 the final month after a cancellation (review BE-14)', () => {
  it('invoices the month the service ends in, and nothing after it', async () => {
    const c = await oldCompany('Final Month Agency');
    await at(`${last}-15T10:00:00Z`, () => subscriptions.cancel(c.admin, 'Moving to paper'));
    const state = await lifecycle.daily(c.companyId);
    expect(state).toMatchObject({ status: 'cancelled' });
    const due = await billing.dueMonths(c.companyId);
    expect(due!.months.at(-1)).toBe(last);
    const issued = await billing.invoiceDue(c.companyId);
    expect(issued.length).toBeGreaterThan(0);
    const months = (await invoicesOf(c.companyId)).map((i) => i.month);
    expect(months.at(-1)).toBe(last);
    // The month after the service ended is never snapshotted or invoiced.
    const later = `${monthBounds(nextMonth(month)).first}T10:00:00Z`;
    await at(later, async () => {
      expect((await billing.dueMonths(c.companyId))!.months).toEqual([]);
      expect(await billing.snapshotDue(c.companyId)).toEqual([]);
      expect(await billing.invoiceDue(c.companyId)).toEqual([]);
      expect(await billing.invoice(c.companyId, { month })).toBeNull();
    });
    expect(
      await rows('select 1 from billing_snapshot where subscriber_company_id = $1 and month = $2', [
        c.companyId,
        month,
      ]),
    ).toHaveLength(0);
  });
});

describe('PB-07 reconciliation looks references up as one array parameter (review BE-27)', () => {
  it('finds the day’s platform payments by reference, whatever characters another reference holds', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Reference Agency');
    await subscribe(ctx, sp, c.companyId);
    await openInvoice(ctx, b.posting, c.companyId, {
      month: last,
      totalMinor: 4_321,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    const started = await payByCard(c);
    const listed = await p.primary.verifyTransaction(started.reference);
    // A day long past: our payment is found only through its reference, not its time.
    const range = ReconciliationService.dayRange(plusDays(today, -40));
    const odd = {
      ...listed,
      reference: 'SUB-odd "quoted", {braced} \\',
      status: 'failed' as const,
    };
    const result = await sp.payments.reconcile('paystack', range, [odd, listed], []);
    expect(result).toEqual({ matched: 1, processed: 0, exceptions: 0 });
  });
});

describe('PB-07 the platform’s provider clearing against the provider (review BE-26)', () => {
  it('names the provider on P26’s clearing lines, and agrees through payment, chargeback and payout', async () => {
    const paying = await moneyCompany(ctx, s, 'agency', 'Clearing Agency');
    await subscribe(ctx, sp, paying.companyId);
    await openInvoice(ctx, b.posting, paying.companyId, {
      month: last,
      totalMinor: 12_000,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    const payment = await payByCard(paying, 300);
    expect(
      (await entry(subscriptionPostingKeys.payment(payment.id))).lines.find(
        (l) => l.account === '1050',
      ),
    ).toMatchObject({ amount: 12_000, provider: 'paystack', book: 'platform' });

    const disputed = await moneyCompany(ctx, s, 'agency', 'Chargeback Agency');
    await subscribe(ctx, sp, disputed.companyId);
    await openInvoice(ctx, b.posting, disputed.companyId, {
      month: last,
      totalMinor: 8_000,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    const takenBack = await payByCard(disputed);
    const dispute = await p.primary.chargeback(takenBack.reference);
    expect((await deliverWebhook(ctx, p, 'paystack', dispute)).outcome).toBe('reversed');
    expect(
      (await entry(subscriptionPostingKeys.paymentReversal(takenBack.id))).lines.find(
        (l) => l.account === '1050',
      ),
    ).toMatchObject({ amount: -8_000, provider: 'paystack', book: 'platform' });

    // Before the payout: our clearing is what the provider holds for the platform.
    const before = clearingAlerts().length;
    await p.reconciliation.clearing('paystack', today);
    expect(clearingAlerts()).toHaveLength(before);
    expect(await platformClearing('paystack')).toBeGreaterThan(0);

    // The payout of the platform balance (with the chargeback deducted) clears it to nothing.
    expect((await p.primary.settle()).some((x) => x.subaccountCode === '')).toBe(true);
    expect(await p.reconciliation.settlements('paystack', today)).toBeGreaterThanOrEqual(1);
    expect(await platformClearing('paystack')).toBe(0);
    expect(clearingAlerts()).toHaveLength(before);
    expect(p.alerts.some((a) => a.code === 'subscription.settlement_difference')).toBe(false);
  });

  it('raises a difference when the provider holds platform money the books do not', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Unposted Agency');
    await subscribe(ctx, sp, c.companyId);
    await openInvoice(ctx, b.posting, c.companyId, {
      month: last,
      totalMinor: 7_000,
      issuedOn: plusDays(today, -2),
      dueOn: plusDays(today, 5),
    });
    const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
    await p.primary.completeCharge(started.reference, { status: 'success' });
    // Our side refuses it (the verified amount differs), so nothing posts; the provider keeps it.
    const verified = await p.primary.verifyTransaction(started.reference);
    expect(
      await sp.payments.onVerifiedCharge('paystack', started.reference, {
        ...verified,
        amountMinor: 6_999,
      }),
    ).toBe('rejected');
    const before = clearingAlerts().length;
    await p.reconciliation.clearing('paystack', today);
    const raised = clearingAlerts().slice(before);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.context).toMatchObject({
      provider: 'paystack',
      day: today,
      ourMinor: 0,
      providerMinor: 7_000,
    });
  });
});
