import { Test, type TestingModule } from '@nestjs/testing';
import { sql, withCompany, withSystem } from '@rent/db';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import type { Actor } from '@rent/domain/policy';
import { InMemoryAlert, InMemoryEmail, InMemorySms } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AdminModule } from '../src/admin/admin.module';
import { PlatformCompaniesService } from '../src/admin/companies.service';
import { SystemHealthService } from '../src/admin/health.service';
import { PlatformPricingService } from '../src/admin/pricing.service';
import { SupportAccessService } from '../src/admin/support.service';
import { UsageService } from '../src/admin/usage.service';
import { EntitlementsService } from '../src/companies/entitlements.service';
import { CoreModule } from '../src/core/core.module';
import { createLogger } from '../src/core/logging/logger';
import { MessagingSettingsService } from '../src/messaging/settings.service';
import { PolicyService } from '../src/policy/policy.service';
import { SubscriptionBillingService } from '../src/subscription/billing.service';
import { SubscriptionCoreService } from '../src/subscription/core.service';
import { SubscriptionCreditNotesService } from '../src/subscription/credit-notes.service';
import { SubscriptionLifecycleService } from '../src/subscription/lifecycle.service';
import { withPlatform } from '../src/subscription/platform';
import { SubscriptionService } from '../src/subscription/subscription.service';
import { TaxModule } from '../src/tax';
import { company, member, person, startServerTest, type ServerTestContext } from './support';
import { staffIn } from './support/tenancy';

/**
 * BE-16 (M10 decision 13; review access 2): platform-admin requests never enter a customer company
 * through `withCompany`, whatever actor kind the code declares. Every company transaction opened
 * while the console's operations run is recorded (a spy on @rent/db's `withCompany`, the only way
 * application code enters a company): each must be the platform company's. Customer-side writes
 * (onboarding's first admin, the WhatsApp number's audit event, the subscriber's audit events) go
 * through narrow definer functions from the platform company instead, and still land in the
 * customer's chain as the platform's system path, with the admin as the person.
 */
const spy = vi.hoisted(() => ({
  recording: false,
  entered: [] as { companyId: string; actorKind: string }[],
}));

vi.mock('@rent/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rent/db')>();
  const withCompanySpy: typeof actual.withCompany = (database, ctx, fn, options) => {
    if (spy.recording) spy.entered.push({ companyId: ctx.companyId, actorKind: ctx.actorKind });
    return actual.withCompany(database, ctx, fn, options);
  };
  return { ...actual, withCompany: withCompanySpy };
});

let ctx: ServerTestContext;
let moduleRef: TestingModule;
let platformId: string;
let admin: Extract<Actor, { kind: 'platform_admin' }>;
const email = new InMemoryEmail();

/** Runs `fn` while recording every company the code enters. */
async function recorded<T>(fn: () => Promise<T>): Promise<T> {
  spy.recording = true;
  try {
    return await fn();
  } finally {
    spy.recording = false;
  }
}

async function chain(companyId: string, action: string) {
  return withCompany(
    ctx.database,
    { companyId, actorKind: 'system' },
    async (tx) =>
      (
        await tx.execute<{ actor_kind: string; actor_person_id: string | null }>(
          sql`select actor_kind, actor_person_id from audit_event where action = ${action} order by seq`,
        )
      ).rows,
  );
}

beforeAll(async () => {
  ctx = await startServerTest();
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
  const adminPerson = await person(ctx, 'Guarded Platform Admin');
  admin = {
    kind: 'platform_admin',
    personId: adminPerson,
    companyId: platformId,
    membershipId: await member(ctx, platformId, adminPerson, 'platform_admin'),
    authMethod: 'password_totp',
  };
  // Billing on since January (founder answer Q1), so trials have an end and invoices are issued.
  await withSystem(ctx.database, {}, (tx) =>
    tx.execute(sql`select app.turn_on_billing('2026-01-01'::date, 'BE-16 test')`),
  );
}, 120_000);

afterAll(async () => {
  await moduleRef?.close();
  await ctx?.close();
});

describe('BE-16 AD-10 the console never enters a customer company', () => {
  it('runs every console operation in the platform company only', async () => {
    const companies = moduleRef.get(PlatformCompaniesService);
    const pricing = moduleRef.get(PlatformPricingService);
    const usage = moduleRef.get(UsageService);
    const health = moduleRef.get(SystemHealthService);
    const support = moduleRef.get(SupportAccessService);
    const subscriptions = moduleRef.get(SubscriptionService, { strict: false });
    const credits = moduleRef.get(SubscriptionCreditNotesService, { strict: false });
    const billing = moduleRef.get(SubscriptionBillingService, { strict: false });
    const lifecycle = moduleRef.get(SubscriptionLifecycleService, { strict: false });
    const core = moduleRef.get(SubscriptionCoreService, { strict: false });
    const policy = new PolicyService();
    const settings = new MessagingSettingsService(
      ctx.database,
      policy,
      new EntitlementsService(ctx.database, policy),
      ctx.audit,
    );

    // Set-up outside the record: a subscriber with no trial and an overdue invoice (the test
    // control's path), and a subscriber whose own admin cancels and whose cancellation runs.
    const billed = await company(ctx, 'agency', 'Billed Agency');
    await withPlatform(ctx.database, {}, async (tx, platform) => {
      const found = await core.subscriberCompany(tx, billed);
      await core.ensure(tx, platform, found!, { trialDays: 0 });
    });
    const invoice = await billing.forceOverdueInvoice(billed, 3);
    const leaving = await company(ctx, 'landlord', 'Leaving Landlord');
    const landlord = await staffIn(ctx, leaving, 'landlord', 'owner', 'Leaving owner');
    await withPlatform(ctx.database, {}, async (tx, platform) => {
      const found = await core.subscriberCompany(tx, leaving);
      await core.ensure(tx, platform, found!, { trialDays: 0 });
    });
    const cancelled = await subscriptions.cancel(landlord, 'Selling the house');
    const after = toIsoDate(addDays(parseBusinessDate(cancelled.cancelsOn!), 1));
    expect(await lifecycle.daily(leaving, after)).toMatchObject({ status: 'cancelled' });

    const made = await recorded(async () => {
      const detail = await companies.createCompany(admin, {
        kind: 'agency',
        name: 'Guarded Agency',
        tier: 'starter',
        trialDays: 30,
        adminName: 'Guarded Admin',
        adminEmail: 'guarded.admin@agency.invalid',
      });
      const id = detail.company.id;
      await companies.companies(admin);
      await companies.company(admin, id);
      await companies.setTier(admin, id, 'growth', 'Pilot with the founder');
      await companies.extendTrial(admin, id, 5, 'Onboarding took longer');
      await pricing.addDiscountCode(admin, {
        code: 'GUARD10',
        kind: 'percentage',
        percentBps: 1_000,
        months: 1,
      });
      await companies.applyCode(admin, id, 'GUARD10');
      await subscriptions.invoiceDetailFor(admin, billed, invoice.id);
      const detailOfBilled = await companies.company(admin, billed);
      const snapshotId = detailOfBilled.invoices.find((i) => i.id === invoice.id)!.snapshotId;
      await subscriptions.snapshotFor(admin, billed, snapshotId);
      await credits.credit(admin, billed, invoice.id, { amountMinor: 100, reason: 'Goodwill' });
      await companies.reactivate(admin, leaving, {
        tier: 'starter',
        trialDays: 0,
        reason: 'Came back after selling',
      });
      await subscriptions.billingState(admin);
      await usage.usage(admin);
      await health.health(admin);
      await support.grantsAcrossCompanies(admin);
      await pricing.priceLists(admin);
      await pricing.terms(admin);
      const number = await settings.registerNumber(admin, {
        phoneNumberId: '990000000000016',
        wabaId: '880000000000016',
        displayPhone: '+233302000016',
        displayName: 'Guarded Agency',
        kind: 'company',
        companyId: billed,
      });
      await settings.retireNumber(admin, number.id);
      return { id, numberId: number.id };
    });

    const outside = spy.entered.filter((e) => e.companyId !== platformId);
    expect(outside).toEqual([]);
    expect(spy.entered.length).toBeGreaterThan(10);

    // The customer-side writes landed through the narrow functions, as the system with the admin.
    const system = { actor_kind: 'system', actor_person_id: admin.personId };
    expect(await chain(made.id, 'membership.invited')).toEqual([system]);
    expect(await chain(made.id, 'company.onboarded')).toEqual([system]);
    expect(await chain(billed, 'whatsapp_number.registered')).toEqual([system]);
    expect(await chain(billed, 'whatsapp_number.retired')).toEqual([system]);
    expect(await chain(platformId, 'whatsapp_number.registered')).toEqual([
      { actor_kind: 'platform_admin', actor_person_id: admin.personId },
    ]);
    const roles = await withCompany(
      ctx.database,
      { companyId: made.id, actorKind: 'system' },
      async (tx) =>
        (await tx.execute<{ role: string }>(sql`select role from membership`)).rows.map(
          (r) => r.role,
        ),
    );
    expect(roles).toEqual(['agency_admin']);
  });

  it('refuses the narrow onboarding function to anyone but a platform admin in the platform company', async () => {
    const target = await company(ctx, 'agency', 'Not Onboarded Agency');
    const someone = await person(ctx, 'Someone');
    const attempt = (context: Parameters<typeof withCompany>[1]) =>
      withCompany(ctx.database, context, (tx) =>
        tx.execute(
          sql`select app.onboard_first_admin(${target}::uuid, ${someone}::uuid, '{}'::jsonb)`,
        ),
      ).then(
        () => 'ran',
        (error: unknown) =>
          (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code,
      );
    // As the platform's system path, as the customer's own staff, and as an admin in the customer.
    expect(await attempt({ companyId: platformId, actorKind: 'system' })).toBe('RA113');
    expect(await attempt({ companyId: target, personId: admin.personId, actorKind: 'staff' })).toBe(
      'RA113',
    );
    expect(
      await attempt({ companyId: target, personId: admin.personId, actorKind: 'platform_admin' }),
    ).toBe('RA113');
    // A company that has its first admin is never given another this way.
    const onboarded = (
      await moduleRef.get(PlatformCompaniesService).createCompany(admin, {
        kind: 'landlord',
        name: 'Once Only Landlord',
        tier: 'starter',
        adminName: 'Once Only',
        adminEmail: 'once.only@landlord.invalid',
      })
    ).company.id;
    const again = await withCompany(
      ctx.database,
      { companyId: platformId, personId: admin.personId, actorKind: 'platform_admin' },
      (tx) =>
        tx.execute(
          sql`select app.onboard_first_admin(${onboarded}::uuid, ${someone}::uuid, '{}'::jsonb)`,
        ),
    ).then(
      () => 'ran',
      (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
    );
    expect(again).toBe('RA114');
  });
});
