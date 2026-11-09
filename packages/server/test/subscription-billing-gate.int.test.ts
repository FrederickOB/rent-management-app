import { sql, withSystem } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { monthBounds, monthOf, nextMonth } from '@rent/domain/subscription';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoNow } from '../src/billing/records';
import { AppError } from '../src/core/errors';
import { SubscriptionBillingService } from '../src/subscription/billing.service';
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
import { paymentsServices, type PaymentsServices } from './support/payments';
import {
  subscriptionPaymentsServices,
  type SubscriptionPaymentsServices,
} from './support/subscription-payments';
import { tenancyServices, type TenancyServices } from './support/tenancy';

/**
 * Founder answer Q1 (M10 review BE-5): billing stays off until a platform admin turns it on. No
 * snapshot or invoice before then, the test control refuses, trials have no end yet; turning it
 * on is refused on placeholder prices and when already on, and starts every waiting trial from
 * that day. Runs in its own database: billing starts off here.
 */
let ctx: ServerTestContext;
let s: TenancyServices;
let b: BillingServices;
let p: PaymentsServices;
let sp: SubscriptionPaymentsServices;
let billing: SubscriptionBillingService;
let subscriptions: SubscriptionService;
let admin: {
  kind: 'platform_admin';
  personId: string;
  companyId: string;
  membershipId: string;
  authMethod: 'password_totp';
};
let today: string;

const plusDays = (date: string, n: number) => toIsoDate(addDays(parseBusinessDate(date), n));

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
  subscriptions = new SubscriptionService(
    ctx.database,
    sp.core,
    billing,
    s.policy,
    s.rules,
    s.documents,
  );
  const platformId = await company(ctx, 'platform', 'Rent Platform');
  const personId = await person(ctx, 'Gate Platform Admin');
  const membershipId = await member(ctx, platformId, personId, 'platform_admin');
  admin = {
    kind: 'platform_admin',
    personId,
    companyId: platformId,
    membershipId,
    authMethod: 'password_totp',
  };
  today = isoNow(ctx.clock, 'Africa/Accra');
}, 120_000);

afterAll(async () => {
  await ctx?.close();
});

describe('BE-5 billing stays off until a platform admin turns it on (founder answer Q1)', () => {
  it('★ invoices nothing, refuses the test control, and keeps trials open while off; then starts them from the day it goes on', async () => {
    const c = await moneyCompany(ctx, s, 'agency', 'Gate Agency');
    await asSuperuser(
      ctx,
      `update company set created_at = now() - interval '120 days' where id = $1`,
      [c.companyId],
    );
    const before = await subscriptions.view(c.admin);
    expect(before).toMatchObject({
      status: 'trialing',
      trialEndsOn: null,
      billing: { on: false, startsOn: null },
    });
    expect(await billing.snapshot(c.companyId)).toBeNull();
    expect(await billing.invoice(c.companyId)).toBeNull();
    expect(
      await billing.forceOverdueInvoice(c.companyId, 3).catch((e: AppError) => [e.status, e.code]),
    ).toEqual([409, 'billing_off']);
    expect(
      await subscriptions
        .extendTrial(admin, c.companyId, 10, 'Asked for more time')
        .catch((e: AppError) => e.code),
    ).toBe('billing_off');

    // The placeholder price lists stop it, named.
    expect(await subscriptions.billingState(admin)).toMatchObject({
      on: false,
      startsOn: null,
      placeholderTiers: ['starter', 'growth', 'portfolio'],
    });
    const startsOn = monthBounds(nextMonth(monthOf(today))).first;
    expect(
      await subscriptions
        .turnOnBilling(admin, { startsOn })
        .catch((e: AppError) => [e.status, e.code]),
    ).toEqual([409, 'placeholder_prices']);
    expect(
      await subscriptions
        .turnOnBilling(admin, { startsOn: plusDays(today, -1) })
        .catch((e: AppError) => [e.status, e.code]),
    ).toEqual([400, 'effective_from_past']);

    // Real prices from that month, as a platform admin adds them; then billing goes on.
    await withSystem(ctx.database, {}, async (tx) => {
      for (const [tier, minimum] of [
        ['starter', 5_000],
        ['growth', 15_000],
        ['portfolio', 40_000],
      ] as const)
        await tx.execute(
          sql`select app.add_price_list(${tier}, 500, 1000, 2000, ${minimum}, 1000, ${startsOn}::date, false)`,
        );
    });
    const on = await subscriptions.turnOnBilling(admin, { startsOn, note: 'Launch' });
    expect(on).toMatchObject({ on: false, startsOn, placeholderTiers: [] });
    expect(
      await subscriptions.turnOnBilling(admin, { startsOn }).catch((e: AppError) => e.code),
    ).toBe('billing_already_on');

    // The waiting trial runs 30 days from the day billing goes on.
    const after = await subscriptions.view(c.admin);
    expect(after).toMatchObject({
      status: 'trialing',
      trialEndsOn: plusDays(startsOn, 29),
      billing: { on: false, startsOn },
    });
    // A company onboarded after it gets its trial at once, from its own start.
    const later = await moneyCompany(ctx, s, 'landlord', 'Gate Landlord');
    expect((await subscriptions.view(later.admin)).trialEndsOn).toBe(plusDays(startsOn, 29));
    // Nothing is invoiced for a month before billing starts.
    expect(await billing.invoice(c.companyId)).toBeNull();
    // The activation is recorded once, append-only, with who.
    const rows = await withPlatform(ctx.database, {}, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from billing_activation`),
    );
    expect(rows.rows[0]!.n).toBe(1);
  });
});
