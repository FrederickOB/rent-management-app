import { Test, type TestingModule } from '@nestjs/testing';
import { sql, withCompany, withSystem } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { InMemoryAlert, InMemoryEmail, InMemorySms } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { AdminModule } from '../src/admin/admin.module';
import { bootstrapPlatform, PlatformAdminExistsError } from '../src/admin/bootstrap';
import { PlatformCompaniesService } from '../src/admin/companies.service';
import { firstMonthPriced, PlatformPricingService } from '../src/admin/pricing.service';
import { SupportAccessService } from '../src/admin/support.service';
import { CoreModule } from '../src/core/core.module';
import { IdempotencyStore, requestHash } from '../src/core/idempotency';
import { createLogger } from '../src/core/logging/logger';
import { PersonAccounts } from '../src/identity/person-accounts';
import { SubscriptionBillingService } from '../src/subscription/billing.service';
import { SubscriptionCoreService } from '../src/subscription/core.service';
import { withPlatform } from '../src/subscription/platform';
import { SubscriptionService } from '../src/subscription/subscription.service';
import { TaxModule } from '../src/tax';
import { company, member, person, startServerTest, type ServerTestContext } from './support';
import { staffIn } from './support/tenancy';

/**
 * M10 review, the console's items, wired as Nest wires AdminModule on a fixed clock:
 * - BE-20: onboarding is one transaction; under an Idempotency-Key a retry makes nothing twice.
 * - BE-25: a price list may start on any future day, but a month is priced with the list in force
 *   on its 1st: a list dated the 15th changes neither this month's estimate nor its invoice, and
 *   prices next month; the console names the first month each list prices.
 * - BE-27: the support overview names no one; `platform:bootstrap` refuses a second platform
 *   admin unless asked to add one.
 */
let ctx: ServerTestContext;
let moduleRef: TestingModule;
let platformId: string;
let admin: Extract<Actor, { kind: 'platform_admin' }>;
const email = new InMemoryEmail();

/** Monday 9 November 2026, 10:00 in Accra. */
const START = new Date('2026-11-09T10:00:00Z');
/**
 * The month after the real one, and the one after it. A new price list must take effect after
 * the database's real date (RA112), so the price-list tests run in that month, on its 9th, 15th
 * and 20th as before; a fixed November 2026 failed once the real date passed the 15th
 * (founder-approved setup fix, 2026-11-19).
 */
const monthAfter = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const MONTH = monthAfter(new Date().toISOString().slice(0, 7));
const NEXT_MONTH = monthAfter(MONTH);
const inMonth = () => {
  ctx.clock.set(new Date(`${MONTH}-09T10:00:00Z`));
  onTestFinished(() => ctx.clock.set(START));
};

beforeAll(async () => {
  ctx = await startServerTest();
  ctx.clock.set(START);
  moduleRef = await Test.createTestingModule({
    imports: [
      CoreModule.forRoot({
        config: ctx.config,
        database: ctx.database,
        clock: ctx.clock,
        storage: ctx.storage,
        sms: new InMemorySms(),
        email,
        alerts: new InMemoryAlert(),
        logger: createLogger({ level: 'silent' }),
      }),
      AdminModule,
      TaxModule,
    ],
  }).compile();
  await moduleRef.init();
  platformId = await company(ctx, 'platform', 'Rent Platform');
  const adminPerson = await person(ctx, 'Console Review Admin');
  admin = {
    kind: 'platform_admin',
    personId: adminPerson,
    companyId: platformId,
    membershipId: await member(ctx, platformId, adminPerson, 'platform_admin'),
    authMethod: 'password_totp',
  };
  await withSystem(ctx.database, {}, (tx) =>
    tx.execute(sql`select app.turn_on_billing('2026-01-01'::date, 'console review test')`),
  );
}, 120_000);

afterAll(async () => {
  await moduleRef?.close();
  await ctx?.close();
});

describe('BE-20 AD-10 onboarding under an Idempotency-Key', () => {
  it('makes one company, one admin and one invitation however often it is retried', async () => {
    const companies = moduleRef.get(PlatformCompaniesService);
    const store = new IdempotencyStore(ctx.database);
    const input = {
      kind: 'agency' as const,
      name: 'Retried Agency',
      tier: 'starter' as const,
      trialDays: 30,
      adminName: 'Retried Admin',
      adminEmail: 'retried.admin@agency.invalid',
    };
    const run = () =>
      store.run(
        {
          companyId: platformId,
          personId: admin.personId,
          key: 'onboard-retried-agency',
          operation: 'platformAdmin.createCompany',
          hash: requestHash('platformAdmin.createCompany', admin.personId, input),
        },
        async (claim) => ({ companyId: await companies.onboard(admin, input, null, claim) }),
      );
    const first = await run();
    const again = await run();
    expect(again).toEqual(first);
    const named = (await companies.companies(admin)).filter(
      (c) => c.company.name === 'Retried Agency',
    );
    expect(named.map((c) => c.company.id)).toEqual([first.companyId]);
    expect(email.sent.filter((m) => m.to === 'retried.admin@agency.invalid')).toHaveLength(1);
  });

  it('leaves nothing behind when the transaction fails part way', async () => {
    const companies = moduleRef.get(PlatformCompaniesService);
    const before = await withSystem(ctx.database, {}, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from app.company_ids()`),
    );
    const failing = {
      claim: async () => undefined,
      done: async () => {
        throw new Error('the answer could not be stored');
      },
    };
    await expect(
      companies.onboard(
        admin,
        {
          kind: 'landlord',
          name: 'Half Made Landlord',
          tier: 'starter',
          adminName: 'Half Made',
          adminEmail: 'half.made@landlord.invalid',
        },
        null,
        failing,
      ),
    ).rejects.toThrow('the answer could not be stored');
    const after = await withSystem(ctx.database, {}, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from app.company_ids()`),
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(
      (await companies.companies(admin)).some((c) => c.company.name === 'Half Made Landlord'),
    ).toBe(false);
    expect(email.sent.some((m) => m.to === 'half.made@landlord.invalid')).toBe(false);
  });
});

describe('BE-25 PB-03 a price list is in force for a month from the month’s 1st', () => {
  it('names the first month a list prices', () => {
    expect(firstMonthPriced('2026-12-01')).toBe('2026-12');
    expect(firstMonthPriced('2026-11-15')).toBe('2026-12');
    expect(firstMonthPriced('2026-12-31')).toBe('2027-01');
  });

  it('prices this month with the list of its 1st, and next month with a list dated the 15th', async () => {
    inMonth();
    const pricing = moduleRef.get(PlatformPricingService);
    const subscriptions = moduleRef.get(SubscriptionService, { strict: false });
    const billing = moduleRef.get(SubscriptionBillingService, { strict: false });
    const core = moduleRef.get(SubscriptionCoreService, { strict: false });
    const agency = await company(ctx, 'agency', 'Mid Month Agency');
    await withPlatform(ctx.database, {}, async (tx, platform) => {
      const found = await core.subscriberCompany(tx, agency);
      await core.ensure(tx, platform, { ...found!, plan: 'growth' }, { trialDays: 0 });
    });
    const estimateBefore = (await subscriptions.viewFor(agency)).estimate;

    const midMonth = await pricing.addPriceList(admin, {
      tier: 'growth',
      ratesMinor: { single_room: 1_100, self_contained: 2_100, commercial: 4_100 },
      minimumMinor: 99_900,
      annualDiscountBps: 0,
      effectiveFrom: `${MONTH}-15`,
    });
    expect(midMonth).toMatchObject({ effectiveFrom: `${MONTH}-15`, appliesFromMonth: NEXT_MONTH });
    expect(
      (await pricing.priceLists(admin)).find((l) => l.id === midMonth.id)!.appliesFromMonth,
    ).toBe(NEXT_MONTH);

    // On the 20th, the list dated the 15th is in force, but this month is still priced on its 1st.
    ctx.clock.set(new Date(`${MONTH}-20T10:00:00Z`));
    try {
      expect((await subscriptions.viewFor(agency)).estimate).toEqual(estimateBefore);
      const november = await billing.invoice(agency, { month: MONTH });
      const december = await billing.invoice(agency, { month: NEXT_MONTH });
      // No units let: each bill is the Growth minimum. This month's comes from the placeholder list
      // in force on its 1st (GH₵150, prorated from the start), never the new GH₵999.
      expect(november!.totalMinor).toBeGreaterThan(0);
      expect(november!.totalMinor).toBeLessThanOrEqual(15_000);
      expect(december!.totalMinor).toBe(99_900);
    } finally {
      ctx.clock.set(START);
    }
  });

  it('shows this month’s plan cards at the rates of its 1st (needs the lead’s viewFor change)', async () => {
    inMonth();
    const pricing = moduleRef.get(PlatformPricingService);
    const subscriptions = moduleRef.get(SubscriptionService, { strict: false });
    const agency = await company(ctx, 'agency', 'Plan Cards Agency');
    const cardsBefore = (await subscriptions.viewFor(agency)).tiers;
    await pricing.addPriceList(admin, {
      tier: 'starter',
      ratesMinor: { single_room: 700, self_contained: 1_300, commercial: 2_700 },
      minimumMinor: 77_700,
      annualDiscountBps: 0,
      effectiveFrom: `${MONTH}-16`,
    });
    ctx.clock.set(new Date(`${MONTH}-20T10:00:00Z`));
    try {
      expect((await subscriptions.viewFor(agency)).tiers).toEqual(cardsBefore);
    } finally {
      ctx.clock.set(START);
    }
  });
});

describe('BE-27 AD-10 the support overview names no one', () => {
  it('tells who acted by kind only', async () => {
    const support = moduleRef.get(SupportAccessService);
    const customer = await company(ctx, 'agency', 'Overview Agency');
    const grantor = await staffIn(ctx, customer, 'agency', 'agency_admin', 'Akosua Grantor');
    await support.grant(grantor, { reason: 'Our statement does not add up', hours: 2 });
    const overview = await support.overview(admin, customer);
    const kinds = new Set(overview.recentAudit.map((e) => e.actorName));
    expect(overview.recentAudit.length).toBeGreaterThan(0);
    for (const kind of kinds)
      expect(['Staff', 'Tenant', 'Platform support', 'System', 'Secure link', null]).toContain(
        kind,
      );
    expect(kinds.has('Staff')).toBe(true);
    expect(JSON.stringify(overview)).not.toContain('Akosua Grantor');
    expect(JSON.stringify(overview)).not.toContain('Console Review Admin');
  });
});

describe('BE-27 AD-10 platform:bootstrap and a second platform admin', () => {
  it('refuses another person once a platform admin exists, unless asked to add one', async () => {
    const accounts = {
      create: moduleRef.get(PersonAccounts).create.bind(moduleRef.get(PersonAccounts)),
    };
    const invited: string[] = [];
    const deps = {
      accounts,
      audit: ctx.audit,
      invite: async (to: string) => void invited.push(to),
    };
    const base = { name: 'Rent Platform', legalName: 'Rent Platform Ltd' };
    // The test's own admin has no account email of their own here; another person is refused.
    await expect(
      bootstrapPlatform(ctx.database, deps, { ...base, email: 'second.admin@platform.invalid' }),
    ).rejects.toBeInstanceOf(PlatformAdminExistsError);
    expect(invited).toEqual([]);
    const persons = await withSystem(ctx.database, {}, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from person where email = 'second.admin@platform.invalid'`,
      ),
    );
    expect(persons.rows[0]!.n).toBe(0);

    const added = await bootstrapPlatform(ctx.database, deps, {
      ...base,
      email: 'second.admin@platform.invalid',
      addAdmin: true,
    });
    expect(added).toMatchObject({
      platformCompanyId: platformId,
      companyCreated: false,
      membershipCreated: true,
    });
    // Run again for that admin: idempotent, as before.
    await expect(
      bootstrapPlatform(ctx.database, deps, { ...base, email: 'second.admin@platform.invalid' }),
    ).resolves.toMatchObject({ membershipCreated: false });
    const admins = await withCompany(
      ctx.database,
      { companyId: platformId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from membership where role = 'platform_admin'`,
        ),
    );
    expect(admins.rows[0]!.n).toBe(2);
  });
});
