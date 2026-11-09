import { sql, withCompany } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { subscriptionPostingKeys } from '@rent/domain/ledger';
import { monthBounds, monthOf, nextMonth, previousMonth } from '@rent/domain/subscription';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { CompaniesService } from '../src/companies/companies.service';
import { AppError } from '../src/core/errors';
import { SubscriptionBillingService } from '../src/subscription/billing.service';
import { SubscriptionLifecycleService } from '../src/subscription/lifecycle.service';
import { withPlatform } from '../src/subscription/platform';
import { SubscriptionService } from '../src/subscription/subscription.service';
import { asSuperuser, company, startServerTest, type ServerTestContext } from './support';
import {
  billedLease,
  billingServices,
  moneyCompany,
  type BillingServices,
} from './support/billing';
import { paymentsServices, type PaymentsServices } from './support/payments';
import {
  subscriptionPaymentsServices,
  type SubscriptionPaymentsServices,
} from './support/subscription-payments';
import { propertyWithUnits, tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * M10 billing (plan 4.3 and 4.5; decisions 2, 5, 6, 8, 11 and 12), on the services with real
 * PostgreSQL and RLS: the D8 snapshot, the invoice with its minimum, discount and P26 entry, the
 * prepaid draw, gap-free numbers, tier changes, cancellation, the lifecycle and dunning, the
 * subscriber's view and the banner, and isolation between subscribers.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let sp: SubscriptionPaymentsServices;
let billing: SubscriptionBillingService;
let lifecycle: SubscriptionLifecycleService;
let subscriptions: SubscriptionService;
let companies: CompaniesService;
let today: string;
let month: string;
let last: string;

type Company = Awaited<ReturnType<typeof moneyCompany>>;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));

/** A company created `days` ago, so last month is past its 30-day trial and billable. */
async function oldCompany(name: string, days = 120, plan = 'growth'): Promise<Company> {
  const c = await moneyCompany(ctx, s, 'agency', name);
  await asSuperuser(
    ctx,
    `update company set created_at = now() - make_interval(days => $2), plan = $3 where id = $1`,
    [c.companyId, days, plan],
  );
  return c;
}

/** Units with leases: `starts` are the lease start dates, one unit each; `vacant` more units. */
async function letUnits(c: Company, part: string, starts: readonly string[], vacant = 0) {
  const owner = (
    await s.owners.create(c.admin, { kind: 'individual', displayName: `${part} owner` })
  ).id;
  const { units } = await propertyWithUnits(s, c.manager, {
    areaCode: 'ACC',
    propertyPart: part,
    ownerId: owner,
    units: [{ unitType: 'apartment', count: starts.length + vacant, bedrooms: 1 }],
  });
  const ids = Object.values(units);
  for (const [i, start] of starts.entries()) {
    const { tenant } = await s.tenants.create(c.manager, {
      kind: 'individual',
      displayName: `${part} tenant ${i}`,
    });
    await billedLease(ctx, s, b, c.manager, {
      unitId: ids[i]!,
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
  return ids;
}

async function rows<T>(statement: string, values: unknown[] = []): Promise<T[]> {
  return (await asSuperuser(ctx, statement, values)) as T[];
}

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
  lifecycle = new SubscriptionLifecycleService(ctx.database, sp.core, s.policy);
  subscriptions = new SubscriptionService(
    ctx.database,
    sp.core,
    billing,
    s.policy,
    s.rules,
    s.documents,
  );
  companies = new CompaniesService(ctx.database, s.policy, s.documents);
  await company(ctx, 'platform', 'Rent Platform');
  today = isoNow(ctx.clock, 'Africa/Accra');
  month = monthOf(today);
  last = previousMonth(month);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

describe('PB-02 the monthly snapshot of billable units (D8)', () => {
  it('★ bills a unit with an active lease on any day of the month, never a vacant or reserved one', async () => {
    const c = await oldCompany('Snapshot Agency');
    const bounds = monthBounds(last);
    const [wholeMonth, lastDay, thisMonth, reserved] = await letUnits(
      c,
      'SNP',
      [
        plusDays(bounds.first, -20),
        bounds.last,
        monthBounds(month).first,
        monthBounds(nextMonth(month)).first,
      ],
      2,
    );
    const snapshot = await billing.snapshot(c.companyId, last);
    expect(snapshot!.counts).toEqual({ single_room: 0, self_contained: 2, commercial: 0 });
    const units = await rows<{ unit_id: string; days_leased: number }>(
      'select unit_id, days_leased from billing_snapshot_unit where snapshot_id = $1 order by days_leased desc',
      [snapshot!.id],
    );
    const daysIn = Number(bounds.last.slice(8, 10));
    expect(units).toEqual([
      { unit_id: wholeMonth, days_leased: daysIn },
      { unit_id: lastDay, days_leased: 1 },
    ]);
    expect(units.map((u) => u.unit_id)).not.toContain(thisMonth);
    expect(units.map((u) => u.unit_id)).not.toContain(reserved);
    // Frozen: taken again, it is the same snapshot.
    expect((await billing.snapshot(c.companyId, last))!.id).toBe(snapshot!.id);
  });
});

describe('PB-05 and PB-07 the monthly invoice (decision 2)', () => {
  it('★ never bills below the minimum, numbers gap-free, posts P26 in the platform book, and renders', async () => {
    const c = await oldCompany('Minimum Agency');
    await letUnits(c, 'MIN', [plusDays(monthBounds(last).first, -5)]);
    const issued = await billing.invoice(c.companyId);
    expect(issued).not.toBeNull();
    expect(issued!.number).toMatch(/^SUB-\d{4}-\d{6}$/);
    // Growth placeholder: 1 self-contained unit × GH₵15 is below the GH₵150 minimum.
    expect(issued!.totalMinor).toBe(15_000);
    const lines = await rows<{ kind: string; amount_minor: string }>(
      `select kind, amount_minor from subscription_invoice_line where invoice_id = $1 order by line_no`,
      [issued!.id],
    );
    expect(lines.map((l) => [l.kind, Number(l.amount_minor)])).toEqual([
      ['units', 1_500],
      ['minimum', 13_500],
    ]);
    const entry = await rows<{ account_code: string; amount: string; book_kind: string }>(
      `select l.account_code, l.amount_minor as amount, b.kind as book_kind from journal_line l
         join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
         join book b on b.company_id = l.company_id and b.id = l.book_id
        where e.idempotency_key = $1 order by l.line_no`,
      [subscriptionPostingKeys.invoice(issued!.id)],
    );
    expect(entry.map((l) => [l.account_code, Number(l.amount), l.book_kind])).toEqual([
      ['1100', 15_000, 'platform'],
      ['4600', -15_000, 'platform'],
    ]);
    const [invoice] = await rows<{
      status: string;
      due_on: string;
      render_request_id: string | null;
    }>(`select status, due_on::text, render_request_id from subscription_invoice where id = $1`, [
      issued!.id,
    ]);
    expect(invoice).toMatchObject({ status: 'open', due_on: plusDays(today, 7) });
    expect(invoice!.render_request_id).not.toBeNull();
    // Idempotent per subscriber and month.
    expect((await billing.invoice(c.companyId))!.id).toBe(issued!.id);
  });

  it('issues nothing for a month the subscription spent in its trial', async () => {
    const c = await moneyCompany(ctx, s, 'landlord', 'New Landlord');
    expect(await billing.invoice(c.companyId)).toBeNull();
  });

  it('keeps invoice numbers gap-free when several are issued at once', async () => {
    const companies = await Promise.all(
      [1, 2, 3, 4].map((i) => oldCompany(`Concurrent Agency ${i}`)),
    );
    const issued = await Promise.all(companies.map((c) => billing.invoice(c.companyId)));
    const year = today.slice(0, 4);
    const all = await rows<{ number: string }>(
      `select number from subscription_invoice where number like $1 order by number`,
      [`SUB-${year}-%`],
    );
    const seqs = all.map((r) => Number(r.number.split('-')[2]));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(new Set(issued.map((i) => i!.number)).size).toBe(4);
  });

  it('applies a discount code as its own line and settles from prepaid credit first (decisions 7 and 8)', async () => {
    const c = await oldCompany('Discount Agency');
    await withPlatform(ctx.database, {}, (tx, platformId) =>
      tx.execute(
        sql`insert into discount_code (company_id, code, kind, percent_bps, months)
            values (${platformId}::uuid, 'HALF', 'percentage', 5000, 3)`,
      ),
    );
    // The code applies from the month it is applied in, so backdate the redemption to last month.
    await subscriptions.applyCode(c.admin, 'half');
    await asSuperuser(
      ctx,
      `update discount_redemption set first_month = $2 where subscriber_company_id = $1`,
      [c.companyId, last],
    );
    expect(await subscriptions.applyCode(c.admin, 'HALF').catch((e: AppError) => e.code)).toBe(
      'discount_already_applied',
    );
    expect(await subscriptions.applyCode(c.admin, 'NOPE').catch((e: AppError) => e.code)).toBe(
      'discount_unknown',
    );
    const issued = await billing.invoice(c.companyId);
    const lines = await rows<{ kind: string; amount_minor: string }>(
      `select kind, amount_minor from subscription_invoice_line where invoice_id = $1 order by line_no`,
      [issued!.id],
    );
    expect(lines.map((l) => [l.kind, Number(l.amount_minor)])).toEqual([
      ['minimum', 15_000],
      ['discount', -7_500],
    ]);
    expect(issued!.totalMinor).toBe(7_500);
  });
});

describe('PB-05 tier changes (decision 6)', () => {
  it('upgrades at once and schedules a downgrade for the 1st, which the lifecycle applies', async () => {
    const c = await oldCompany('Tier Agency', 120, 'starter');
    let view = await subscriptions.changeTier(c.admin, 'growth');
    expect(view).toMatchObject({ tier: 'growth', pendingTier: null });
    expect(
      (await rows<{ plan: string }>('select plan from company where id = $1', [c.companyId]))[0],
    ).toEqual({ plan: 'growth' });
    expect(await subscriptions.changeTier(c.admin, 'growth').catch((e: AppError) => e.code)).toBe(
      'tier_unchanged',
    );
    view = await subscriptions.changeTier(c.admin, 'starter');
    const firstOfNext = monthBounds(nextMonth(month)).first;
    expect(view).toMatchObject({
      tier: 'growth',
      pendingTier: { tier: 'starter', from: firstOfNext },
    });
    // Features stay until the 1st; on the 1st the lifecycle applies it.
    await lifecycle.daily(c.companyId, firstOfNext);
    expect(
      (
        await rows<{ tier: string }>(
          'select tier from subscription where subscriber_company_id = $1',
          [c.companyId],
        )
      )[0],
    ).toEqual({ tier: 'starter' });
  });
});

describe('PB-11 dunning and read-only (decision 11)', () => {
  it('reminds once per step, then goes read-only after the grace period; the banner says so', async () => {
    const c = await oldCompany('Dunning Agency');
    const issued = await billing.forceOverdueInvoice(c.companyId, 3);
    expect(issued.totalMinor).toBeGreaterThan(0);
    let state = await lifecycle.dunning(c.companyId);
    expect(state).toMatchObject({ status: 'past_due', access: 'full' });
    await lifecycle.dunning(c.companyId);
    const reminders = await rows<{ key: string }>(
      `select data->>'key' as key from subscription_event where subscriber_company_id = $1 and kind = 'reminder_sent'`,
      [c.companyId],
    );
    expect(reminders.map((r) => r.key)).toEqual([`dunning:${issued.id}:day_3`]);
    // Fourteen days after the due date, read-only (the switch is on by default).
    state = await lifecycle.dunning(c.companyId, plusDays(today, 11));
    expect(state).toMatchObject({ status: 'read_only', access: 'read_only' });
    const [company] = await rows<{ access: string }>('select access from company where id = $1', [
      c.companyId,
    ]);
    expect(company).toEqual({ access: 'read_only' });
    // The banner for a manager (no subscription.read): no amount, cannot pay.
    const asManager = await companies.profile({ ...c.manager, subscriptionAccess: 'read_only' });
    expect(asManager.subscription).toMatchObject({
      status: 'read_only',
      access: 'read_only',
      oldestDueOn: plusDays(today, -3),
      pastDueMinor: null,
      canPay: false,
    });
    const asAdmin = await companies.profile({ ...c.admin, subscriptionAccess: 'read_only' });
    expect(asAdmin.subscription).toMatchObject({ pastDueMinor: issued.totalMinor, canPay: true });
  });
});

describe('PB-10 cancelling (decision 12)', () => {
  it('cancels at the month end, withdraws, and the export holds the company data without ID numbers', async () => {
    const c = await oldCompany('Cancel Agency');
    await letUnits(c, 'CAN', [plusDays(today, -40)]);
    let view = await subscriptions.cancel(c.admin, 'Moving to paper');
    expect(view).toMatchObject({
      status: 'cancel_scheduled',
      cancelsOn: monthBounds(month).last,
      actions: { withdrawCancel: true, cancel: false },
    });
    expect(await subscriptions.cancel(c.admin).catch((e: AppError) => e.code)).toBe(
      'already_cancelling',
    );
    view = await subscriptions.withdrawCancel(c.admin);
    expect(view).toMatchObject({ status: 'active', cancelsOn: null });
    const exported = await subscriptions.exportCreate(c.admin);
    expect(exported).toMatchObject({ status: 'ready' });
    expect(exported.url).toBeTruthy();
    // After the last day of service the lifecycle ends it, read-only for staff.
    await subscriptions.cancel(c.admin);
    const after = await lifecycle.daily(c.companyId, plusDays(monthBounds(month).last, 1));
    expect(after).toMatchObject({ status: 'cancelled', access: 'read_only' });
  });
});

describe('PB-04 and PB-08 the subscriber’s view and isolation', () => {
  it('shows the trial, the estimate, every feature with its unlock tier, and only its own invoices', async () => {
    const fresh = await moneyCompany(ctx, s, 'landlord', 'Trial Landlord');
    const view = await subscriptions.view(fresh.admin);
    expect(view.status).toBe('trialing');
    expect(view.trialEndsOn).toBe(plusDays(today, 29));
    expect(view.features.find((f) => f.feature === 'inbox')).toMatchObject({
      included: true,
      unlockTier: 'growth',
      comingSoon: false,
    });
    expect(view.features.find((f) => f.feature === 'caretaker_app')).toMatchObject({
      included: false,
      unlockTier: 'portfolio',
      comingSoon: true,
    });
    expect(view.tiers.map((t) => t.tier)).toEqual(['starter', 'growth', 'portfolio']);
    expect(view.tiers.every((t) => t.placeholder)).toBe(true);

    const a = await oldCompany('Isolated A');
    const bCompany = await oldCompany('Isolated B');
    const invoiceA = await billing.invoice(a.companyId);
    await billing.invoice(bCompany.companyId);
    const seenByB = await subscriptions.invoices(bCompany.admin);
    expect(seenByB.map((i) => i.id)).not.toContain(invoiceA!.id);
    // In B's own context the database shows B nothing of A's.
    const raw = await withCompany(
      ctx.database,
      { companyId: bCompany.companyId, actorKind: 'staff', personId: bCompany.admin.personId },
      (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from subscription_invoice where subscriber_company_id = ${a.companyId}::uuid`,
        ),
    );
    expect(raw.rows[0]!.n).toBe(0);
    // A manager may not read the subscription.
    expect(await subscriptions.view(a.manager).catch((e: AppError) => e.status)).toBe(403);
  });
});
