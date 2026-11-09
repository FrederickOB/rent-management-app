import { sql, withCompany, withSystem } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { subscriptionPostingKeys } from '@rent/domain/ledger';
import {
  cancelEffectiveOn,
  monthBounds,
  monthOf,
  previousMonth,
  shiftMonth,
} from '@rent/domain/subscription';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { AppError } from '../src/core/errors';
import { subscriptionEnded } from '../src/core/subscription-ended';
import { SubscriptionBillingService } from '../src/subscription/billing.service';
import { SubscriptionCreditNotesService } from '../src/subscription/credit-notes.service';
import { SubscriptionLifecycleService } from '../src/subscription/lifecycle.service';
import { withPlatform } from '../src/subscription/platform';
import { SubscriptionService } from '../src/subscription/subscription.service';
import {
  asSuperuser,
  company,
  member,
  person,
  startServerTest,
  type ServerTestContext,
} from './support';
import { billingServices, moneyCompany, type BillingServices } from './support/billing';
import { deliverWebhook, paymentsServices, type PaymentsServices } from './support/payments';
import {
  openInvoice,
  subscribe,
  subscriptionPaymentsServices,
  type SubscriptionPaymentsServices,
} from './support/subscription-payments';
import { tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * The M10 review fixes on the backend lead's side (BE-1, BE-2, BE-3, BE-4, BE-6, BE-12, BE-15 and
 * BE-23), on the services with real PostgreSQL and RLS.
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
let admin: {
  kind: 'platform_admin';
  personId: string;
  companyId: string;
  membershipId: string;
  authMethod: 'password_totp';
};
let today: string;
let month: string;

type Company = Awaited<ReturnType<typeof moneyCompany>>;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));

async function oldCompany(name: string, days = 120): Promise<Company> {
  const c = await moneyCompany(ctx, s, 'agency', name);
  await asSuperuser(
    ctx,
    `update company set created_at = now() - make_interval(days => $2) where id = $1`,
    [c.companyId, days],
  );
  await subscribe(ctx, sp, c.companyId);
  return c;
}

async function rows<T>(statement: string, values: unknown[] = []): Promise<T[]> {
  return (await asSuperuser(ctx, statement, values)) as T[];
}

async function entry(key: string) {
  return rows<{ account_code: string; amount: string; book_kind: string }>(
    `select l.account_code, l.amount_minor as amount, b.kind as book_kind from journal_line l
       join journal_entry e on e.company_id = l.company_id and e.id = l.entry_id
       join book b on b.company_id = l.company_id and b.id = l.book_id
      where e.idempotency_key = $1 order by l.line_no`,
    [key],
  );
}

async function pastDue(c: Company, totalMinor = 12_000) {
  return openInvoice(ctx, b.posting, c.companyId, {
    month: shiftMonth(month, -2),
    totalMinor,
    issuedOn: plusDays(today, -40),
    dueOn: plusDays(today, -33),
  });
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
  const platformId = await company(ctx, 'platform', 'Rent Platform');
  const personId = await person(ctx, 'Review Platform Admin');
  const membershipId = await member(ctx, platformId, personId, 'platform_admin');
  admin = {
    kind: 'platform_admin',
    personId,
    companyId: platformId,
    membershipId,
    authMethod: 'password_totp',
  };
  await withSystem(ctx.database, {}, (tx) =>
    tx.execute(sql`select app.turn_on_billing('2026-01-01'::date, 'M10 review tests')`),
  );
  today = isoNow(ctx.clock, 'Africa/Accra');
  month = monthOf(today);
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

describe('BE-1 PB-07 the status poll verifies a waiting payment with its provider', () => {
  it('★ shows the payment paid, with its receipt and access restored, with no webhook at all', async () => {
    const c = await oldCompany('Poll Agency');
    const invoice = await pastDue(c);
    await lifecycle.dunning(c.companyId);
    expect(
      (
        await rows<{ access: string }>('select access from company where id = $1', [c.companyId])
      )[0],
    ).toEqual({ access: 'read_only' });
    const started = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
    // The charge completes at the provider; its webhook never arrives.
    await p.primary.completeCharge(started.reference, { status: 'success' });
    const polled = await sp.payments.payment(c.admin, started.id);
    expect(polled).toMatchObject({ status: 'succeeded' });
    expect(polled.receiptId).not.toBeNull();
    expect(
      (
        await rows<{ status: string }>('select status from subscription_invoice where id = $1', [
          invoice.id,
        ])
      )[0],
    ).toEqual({ status: 'paid' });
    expect(
      (
        await rows<{ access: string }>('select access from company where id = $1', [c.companyId])
      )[0],
    ).toEqual({ access: 'full' });
    // Polling again changes nothing.
    expect(await sp.payments.payment(c.admin, started.id)).toMatchObject({ status: 'succeeded' });
    expect(await entry(subscriptionPostingKeys.payment(started.id))).toHaveLength(2);
  });
});

describe('BE-3 PB-05 a year ahead never sits beside open invoices', () => {
  it('refuses a year up front while an invoice is open, and offers it again once paid', async () => {
    const c = await oldCompany('Open Agency');
    await openInvoice(ctx, b.posting, c.companyId, {
      month: previousMonth(month),
      totalMinor: 15_000,
      issuedOn: today,
      dueOn: plusDays(today, 7),
    });
    const view = await subscriptions.view(c.admin);
    expect(view).toMatchObject({ openMinor: 15_000, annualPrice: null });
    expect(view.actions.payAnnual).toBe(false);
    expect(
      await sp.payments
        .pay(c.admin, { purpose: 'annual', channel: 'card' })
        .catch((e: AppError) => [e.status, e.code]),
    ).toEqual([409, 'open_invoices']);
    const paid = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
    const webhook = await p.primary.completeCharge(paid.reference, { status: 'success' });
    await deliverWebhook(ctx, p, 'paystack', webhook!);
    const after = await subscriptions.view(c.admin);
    expect(after.openMinor).toBe(0);
    expect(after.actions.payAnnual).toBe(true);
    // No units: 12 minimums is the floor.
    expect(after.annualPrice).toMatchObject({ totalMinor: 180_000, firstMonth: month });
  });

  it('draws prepaid credit onto an invoice at once, so credit never sits beside debt', async () => {
    const c = await oldCompany('Credit Agency');
    const started = await sp.payments.pay(c.admin, { purpose: 'annual', channel: 'card' });
    const webhook = await p.primary.completeCharge(started.reference, { status: 'success' });
    await deliverWebhook(ctx, p, 'paystack', webhook!);
    // An invoice left open beside the credit (as a reversal reopening one would leave it).
    const invoice = await pastDue(c, 9_000);
    await lifecycle.daily(c.companyId);
    expect(
      (
        await rows<{ status: string }>('select status from subscription_invoice where id = $1', [
          invoice.id,
        ])
      )[0],
    ).toEqual({ status: 'paid' });
    const credit = await withPlatform(ctx.database, {}, (tx) =>
      sp.core.creditMinor(tx, c.companyId),
    );
    expect(credit).toBe(180_000 - 9_000);
    expect(
      (await entry(subscriptionPostingKeys.prepaidDraw(invoice.id))).map((l) => [
        l.account_code,
        Number(l.amount),
      ]),
    ).toEqual([
      ['2020', 9_000],
      ['1100', -9_000],
    ]);
    expect(await sp.subledger.check()).toMatchObject({ mismatches: [] });
  });
});

describe('BE-15 PB-10 cancelling during a paid year (founder answer Q3)', () => {
  it('ends the service on the last day of the year paid for, withdrawable until then', async () => {
    const c = await oldCompany('Annual Cancel Agency');
    const started = await sp.payments.pay(c.admin, { purpose: 'annual', channel: 'card' });
    const webhook = await p.primary.completeCharge(started.reference, { status: 'success' });
    await deliverWebhook(ctx, p, 'paystack', webhook!);
    const view = await subscriptions.cancel(c.admin, 'Closing the business');
    const termEnd = monthBounds(shiftMonth(month, 11)).last;
    expect(view).toMatchObject({ status: 'cancel_scheduled', cancelsOn: termEnd });
    expect(view.annual!.endsOn).toBe(termEnd);
    expect((await subscriptions.withdrawCancel(c.admin)).cancelsOn).toBeNull();
  });
});

describe('PB-10 a cancellation within the trial (decision 5, e2e follow-up)', () => {
  it('keeps the trial’s last day in the view while it waits, so the page can say nothing is billed', async () => {
    const fresh = await moneyCompany(ctx, s, 'landlord', 'Trial Cancel Landlord');
    const trialLast = plusDays(today, 29);
    expect((await subscriptions.view(fresh.admin)).trialEndsOn).toBe(trialLast);
    const view = await subscriptions.cancel(fresh.admin, 'Trying something else');
    expect(view).toMatchObject({
      status: 'cancel_scheduled',
      cancelsOn: cancelEffectiveOn({ today, status: 'trialing', trialEndsOn: trialLast }),
      trialEndsOn: trialLast,
    });
    expect(await subscriptions.withdrawCancel(fresh.admin)).toMatchObject({
      status: 'trialing',
      cancelsOn: null,
      trialEndsOn: trialLast,
    });

    // A cancellation long after the trial reports no trial day.
    const old = await oldCompany('Cancel After Trial Agency');
    expect(await subscriptions.cancel(old.admin, 'Moving to paper')).toMatchObject({
      status: 'cancel_scheduled',
      trialEndsOn: null,
    });
  });
});

describe('BE-4 PB-10 after a cancellation (decision 12)', () => {
  it('★ stops rent invoices and automatic messages, archives after the read-only days, and a platform admin can start it again', async () => {
    const c = await oldCompany('Ended Agency');
    expect(await subscriptionEnded(ctx.database, c.companyId)).toBe(false);
    await subscriptions.cancel(c.admin, 'Moving on');
    const lastDay = monthBounds(month).last;
    const after = plusDays(lastDay, 1);
    expect(await lifecycle.daily(c.companyId, after)).toMatchObject({
      status: 'cancelled',
      access: 'read_only',
    });
    expect(await subscriptionEnded(ctx.database, c.companyId)).toBe(true);
    // No new rent invoices, and no automatic tenant messages.
    expect(await b.invoicing.generateAll(c.companyId, after)).toBe(0);
    expect(await p.reminders.run(c.companyId, after)).toBe(0);
    // The final month is billed; nothing after it is snapshotted.
    expect(await billing.snapshot(c.companyId, monthOf(after))).toBeNull();
    // After the read-only days (90 by default), the company is archived.
    const [sub] = await rows<{ read_only_until: string }>(
      `select read_only_until::text from subscription where subscriber_company_id = $1`,
      [c.companyId],
    );
    expect(sub!.read_only_until).toBe(plusDays(lastDay, 90));
    await lifecycle.daily(c.companyId, plusDays(lastDay, 91));
    expect(
      (
        await rows<{ status: string }>('select status from company where id = $1', [c.companyId])
      )[0],
    ).toEqual({ status: 'archived' });
    // Reactivation: a new subscription, the company active again, full access.
    expect(
      await subscriptions
        .reactivate(admin, (await oldCompany('Live Agency')).companyId, {
          tier: 'growth',
          reason: 'Not cancelled',
        })
        .catch((e: AppError) => e.code),
    ).toBe('not_cancelled');
    await subscriptions.reactivate(admin, c.companyId, { tier: 'starter', reason: 'Came back' });
    const subs = await rows<{ status: string; tier: string }>(
      `select status, tier from subscription where subscriber_company_id = $1 order by created_at`,
      [c.companyId],
    );
    expect(subs).toEqual([
      { status: 'cancelled', tier: 'growth' },
      { status: 'active', tier: 'starter' },
    ]);
    expect(
      (
        await rows<{ status: string; access: string; plan: string }>(
          'select status, access, plan from company where id = $1',
          [c.companyId],
        )
      )[0],
    ).toEqual({ status: 'active', access: 'full', plan: 'starter' });
    expect(await subscriptionEnded(ctx.database, c.companyId)).toBe(false);
  });
});

describe('BE-6 PB-07 credit notes on subscription invoices (founder answer Q2)', () => {
  it('★ credits part of an open invoice and all of a paid one, never more than is left, and lifts read-only', async () => {
    const c = await oldCompany('Credited Agency');
    const open = await pastDue(c, 12_000);
    await lifecycle.dunning(c.companyId);
    expect(
      (
        await rows<{ access: string }>('select access from company where id = $1', [c.companyId])
      )[0],
    ).toEqual({ access: 'read_only' });
    const part = await credits.credit(admin, c.companyId, open.id, {
      amountMinor: 2_000,
      reason: 'Two units billed twice',
    });
    expect(part).toMatchObject({
      number: expect.stringMatching(/^SUBC-\d{4}-\d{6}$/),
      amountMinor: 2_000,
    });
    expect(
      (await entry(subscriptionPostingKeys.creditNote(part.id))).map((l) => [
        l.account_code,
        Number(l.amount),
        l.book_kind,
      ]),
    ).toEqual([
      ['4600', 2_000, 'platform'],
      ['1100', -2_000, 'platform'],
    ]);
    expect(
      await credits
        .credit(admin, c.companyId, open.id, { amountMinor: 10_001, reason: 'Too much' })
        .catch((e: AppError) => [e.status, e.code]),
    ).toEqual([409, 'credit_exceeds_invoice']);
    // The rest clears the arrears, so access is full again.
    await credits.credit(admin, c.companyId, open.id, { amountMinor: 10_000, reason: 'Waived' });
    expect(
      (
        await rows<{ status: string }>('select status from subscription_invoice where id = $1', [
          open.id,
        ])
      )[0],
    ).toEqual({ status: 'paid' });
    expect(
      (
        await rows<{ access: string }>('select access from company where id = $1', [c.companyId])
      )[0],
    ).toEqual({ access: 'full' });
    const detail = await subscriptions.invoice(c.admin, open.id);
    expect(detail).toMatchObject({ creditedMinor: 12_000, outstandingMinor: 0 });
    expect(detail.creditNotes.map((n) => n.amountMinor)).toEqual([2_000, 10_000]);

    // A paid invoice credited: the credit goes to prepaid credit (2020) for later invoices.
    const paid = await openInvoice(ctx, b.posting, c.companyId, {
      month: previousMonth(month),
      totalMinor: 15_000,
      issuedOn: today,
      dueOn: plusDays(today, 7),
    });
    const pay = await sp.payments.pay(c.admin, { purpose: 'invoices', channel: 'card' });
    const webhook = await p.primary.completeCharge(pay.reference, { status: 'success' });
    await deliverWebhook(ctx, p, 'paystack', webhook!);
    const full = await credits.credit(admin, c.companyId, paid.id, {
      amountMinor: 15_000,
      reason: 'Goodwill for the outage',
    });
    expect(
      (await entry(subscriptionPostingKeys.creditNote(full.id))).map((l) => [
        l.account_code,
        Number(l.amount),
      ]),
    ).toEqual([
      ['4600', 15_000],
      ['2020', -15_000],
    ]);
    expect(await withPlatform(ctx.database, {}, (tx) => sp.core.creditMinor(tx, c.companyId))).toBe(
      15_000,
    );
    // In the subscriber's chain, and nothing of it seen by another subscriber.
    const audit = await withCompany(
      ctx.database,
      { companyId: c.companyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from audit_event where action = 'subscription.invoice_credited'`,
        ),
    );
    expect(audit.rows[0]!.n).toBe(3);
    const other = await oldCompany('Other Agency');
    const seen = await withCompany(
      ctx.database,
      { companyId: other.companyId, actorKind: 'staff', personId: other.admin.personId },
      (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from subscription_credit_note`),
    );
    expect(seen.rows[0]!.n).toBe(0);
    expect(await sp.subledger.check()).toMatchObject({ mismatches: [] });
  });
});

describe('BE-12 notices and the subscriber’s audit commit with the change', () => {
  it('queues each notice once in the platform outbox and writes each audit event once, whatever the retries', async () => {
    const c = await oldCompany('Retry Agency');
    const issued = await billing.invoice(c.companyId);
    expect(issued).not.toBeNull();
    await billing.invoice(c.companyId);
    const outbox = await rows<{ n: number }>(
      `select count(*)::int as n from outbox_event where type = 'subscription.notify'
         and idempotency_key = $1`,
      [`subscription.notify:${c.companyId}:invoice:${issued!.id}:issued`],
    );
    expect(outbox[0]!.n).toBe(1);
    const audit = await rows<{ n: number }>(
      `select count(*)::int as n from audit_event where company_id = $1 and action = 'subscription.invoice_issued'`,
      [c.companyId],
    );
    expect(audit[0]!.n).toBe(1);
    // A dunning run retried queues the same reminder once.
    await pastDue(c);
    await lifecycle.dunning(c.companyId);
    await lifecycle.dunning(c.companyId);
    const reminders = await rows<{ n: number }>(
      `select count(*)::int as n from outbox_event where type = 'subscription.notify'
         and payload->>'subscriberCompanyId' = $1 and payload->>'key' like 'dunning:%'`,
      [c.companyId],
    );
    expect(reminders[0]!.n).toBe(1);
  });
});

describe('BE-23 the estimate adds up, with the open total and the annual price', () => {
  it('shows units, the minimum top-up, discount and VAT that sum to the total', async () => {
    const c = await oldCompany('Estimate Agency');
    const view = await subscriptions.view(c.admin);
    const e = view.estimate;
    expect(e.unitsMinor + e.minimumTopUpMinor + e.discountMinor + e.vatMinor).toBe(e.totalMinor);
    // No units let: the top-up is the whole minimum.
    expect(e).toMatchObject({ unitsMinor: 0, minimumTopUpMinor: 15_000, totalMinor: 15_000 });
    expect(view).toMatchObject({
      openMinor: 0,
      billing: { on: true, startsOn: '2026-01-01' },
      annualPrice: { netMinor: 180_000, vatMinor: 0, totalMinor: 180_000, discountBps: 1_000 },
    });
  });
});

// Last: it turns VAT on for every later invoice in this database.
describe('BE-2 OQ-48 VAT on subscription invoices when the platform is registered', () => {
  it('★ issues and posts an invoice with VAT, NHIL and GETFund in the platform book', async () => {
    await withSystem(ctx.database, {}, (tx) =>
      tx.execute(sql`select app.add_subscription_terms(${today}::date, 30, 14, true, 7, 90, true)`),
    );
    const c = await oldCompany('VAT Agency');
    const issued = await billing.invoice(c.companyId);
    expect(issued).not.toBeNull();
    // GH₵150 minimum; VAT 15%, NHIL 2.5%, GETFund 2.5% from the unverified rule.
    expect(issued!.totalMinor).toBe(18_000);
    const lines = await rows<{ kind: string; amount_minor: string }>(
      `select kind, amount_minor from subscription_invoice_line where invoice_id = $1 order by line_no`,
      [issued!.id],
    );
    expect(lines.map((l) => [l.kind, Number(l.amount_minor)])).toEqual([
      ['minimum', 15_000],
      ['vat', 2_250],
      ['nhil', 375],
      ['getfund', 375],
    ]);
    expect(
      (await entry(subscriptionPostingKeys.invoice(issued!.id))).map((l) => [
        l.account_code,
        Number(l.amount),
        l.book_kind,
      ]),
    ).toEqual([
      ['1100', 18_000, 'platform'],
      ['4600', -15_000, 'platform'],
      ['2210', -3_000, 'platform'],
    ]);
    const [invoice] = await rows<{ vat_unverified: boolean }>(
      'select vat_unverified from subscription_invoice where id = $1',
      [issued!.id],
    );
    expect(invoice!.vat_unverified).toBe(true);
    // A credit note takes VAT back in the invoice's proportion.
    const note = await credits.credit(admin, c.companyId, issued!.id, {
      amountMinor: 6_000,
      reason: 'Credited a third',
    });
    expect(note).toMatchObject({ netMinor: 5_000, vatMinor: 1_000 });
  });
});
