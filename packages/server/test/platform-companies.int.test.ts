import { Test, type TestingModule } from '@nestjs/testing';
import { sql, withCompany } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { InMemoryAlert, InMemoryEmail, InMemorySms } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminModule } from '../src/admin/admin.module';
import { PlatformCompaniesService } from '../src/admin/companies.service';
import { PlatformPricingService } from '../src/admin/pricing.service';
import { SupportAccessService } from '../src/admin/support.service';
import { CoreModule } from '../src/core/core.module';
import { AppError } from '../src/core/errors';
import { createLogger } from '../src/core/logging/logger';
import { TaxModule } from '../src/tax';
import { company, member, person, startServerTest, type ServerTestContext } from './support';
import { staffIn } from './support/tenancy';

/**
 * AD-10, the console's companies (M10 decisions 4, 5, 6, 8 and 14): onboarding a company (its
 * first admin invited by the same set-password email staff invitations use, its subscription in
 * trial on the chosen tier), the list and a company's page, and a platform admin's direct
 * changes, each audited. Wired as Nest wires AdminModule, on the test database.
 */
let ctx: ServerTestContext;
let moduleRef: TestingModule;
let companies: PlatformCompaniesService;
let pricing: PlatformPricingService;
let support: SupportAccessService;
let platformId: string;
let admin: Extract<Actor, { kind: 'platform_admin' }>;
let outsider: Awaited<ReturnType<typeof staffIn>>;
const email = new InMemoryEmail();

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

async function chain(companyId: string, action: string) {
  return withCompany(
    ctx.database,
    { companyId, actorKind: 'system' },
    async (tx) =>
      (
        await tx.execute<{ actor_kind: string; actor_person_id: string | null; data: unknown }>(
          sql`select actor_kind, actor_person_id, data from audit_event where action = ${action}
            order by seq`,
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
      // Paying the subscription imports billing, which needs rent tax wherever it runs.
      TaxModule,
    ],
  }).compile();
  await moduleRef.init();
  companies = moduleRef.get(PlatformCompaniesService);
  pricing = moduleRef.get(PlatformPricingService);
  support = moduleRef.get(SupportAccessService);
  platformId = await company(ctx, 'platform', 'Rent Platform');
  const adminPerson = await person(ctx, 'Esi Platform Admin');
  admin = {
    kind: 'platform_admin',
    personId: adminPerson,
    companyId: platformId,
    membershipId: await member(ctx, platformId, adminPerson, 'platform_admin'),
    authMethod: 'password_totp',
  };
  const other = await company(ctx, 'agency', 'Other Agency');
  outsider = await staffIn(ctx, other, 'agency', 'agency_admin', 'Other Admin');
});

afterAll(async () => {
  await moduleRef?.close();
  await ctx?.close();
});

describe('AD-10 onboarding and the companies list (decision 14)', () => {
  it('onboards an agency: its admin invited by email, its subscription in trial on the tier', async () => {
    const detail = await companies.createCompany(admin, {
      kind: 'agency',
      name: 'Labone Lettings',
      timeZone: 'Africa/Accra',
      tier: 'starter',
      trialDays: 14,
      adminName: 'Adwoa Labone',
      adminEmail: 'Adwoa.Labone@agency.invalid',
    });
    expect(detail).toMatchObject({
      company: { name: 'Labone Lettings' },
      kind: 'agency',
      tier: 'starter',
      status: 'trialing',
      access: 'full',
      supportGrantActive: false,
      invoices: [],
      supportGrants: [],
    });
    expect(detail.trialEndsOn).not.toBeNull();
    expect(detail.subscription.tier).toBe('starter');
    const companyId = detail.company.id;
    // The same set-password invitation staff invitations send.
    const sent = email.sent.filter((m) => m.to === 'adwoa.labone@agency.invalid');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text ?? '').toContain('accept-invite');
    // In the new company's chain through the platform's system path, with the admin's person.
    const invitedEvents = await chain(companyId, 'membership.invited');
    expect(invitedEvents).toEqual([
      { actor_kind: 'system', actor_person_id: admin.personId, data: { role: 'agency_admin' } },
    ]);
    expect(await chain(companyId, 'company.onboarded')).toHaveLength(1);
    expect(await chain(platformId, 'company.onboarded')).toEqual([
      expect.objectContaining({ actor_kind: 'platform_admin', actor_person_id: admin.personId }),
    ]);
    const listed = (await companies.companies(admin)).find((c) => c.company.id === companyId);
    expect(listed).toMatchObject({ tier: 'starter', status: 'trialing', billableUnits: 0 });
  });

  it('makes a landlord company’s first person its landlord, and refuses bad input', async () => {
    const detail = await companies.createCompany(admin, {
      kind: 'landlord',
      name: 'Nana Owusu',
      tier: 'growth',
      adminName: 'Nana Owusu',
      adminEmail: 'nana.owusu@landlord.invalid',
    });
    const roles = await withCompany(
      ctx.database,
      { companyId: detail.company.id, actorKind: 'system' },
      async (tx) =>
        (await tx.execute<{ role: string }>(sql`select role from membership`)).rows.map(
          (r) => r.role,
        ),
    );
    expect(roles).toEqual(['owner']);
    const base = {
      kind: 'agency' as const,
      name: 'Bad Input Ltd',
      tier: 'starter' as const,
      adminName: 'Kojo Bad',
      adminEmail: 'kojo@bad.invalid',
    };
    expect(
      await refusal(companies.createCompany(admin, { ...base, timeZone: 'Mars/Olympus' })),
    ).toEqual({ status: 400, code: 'bad_time_zone' });
    expect(await refusal(companies.createCompany(admin, { ...base, adminEmail: 'kojo' }))).toEqual({
      status: 400,
      code: 'bad_email',
    });
    expect(await refusal(companies.createCompany(outsider, base))).toEqual({
      status: 403,
      code: 'forbidden',
    });
    expect(await refusal(companies.companies(outsider))).toEqual({
      status: 403,
      code: 'forbidden',
    });
  });

  it('sets a tier with a reason, extends a trial only while trialing, and applies a code', async () => {
    const trialing = await companies.createCompany(admin, {
      kind: 'agency',
      name: 'Trial Agency',
      tier: 'starter',
      trialDays: 30,
      adminName: 'Ekow Trial',
      adminEmail: 'ekow@trial.invalid',
    });
    const id = trialing.company.id;
    expect(await refusal(companies.setTier(admin, id, 'growth', 'ok'))).toEqual({
      status: 400,
      code: 'reason_required',
    });
    expect((await companies.setTier(admin, id, 'growth', 'Pilot with the founder')).tier).toBe(
      'growth',
    );
    const extended = await companies.extendTrial(admin, id, 10, 'Onboarding took longer');
    expect(extended.trialEndsOn! > trialing.trialEndsOn!).toBe(true);

    const noTrial = await companies.createCompany(admin, {
      kind: 'agency',
      name: 'No Trial Agency',
      tier: 'starter',
      trialDays: 0,
      adminName: 'Abla NoTrial',
      adminEmail: 'abla@notrial.invalid',
    });
    expect(
      await refusal(companies.extendTrial(admin, noTrial.company.id, 10, 'Asked for more time')),
    ).toEqual({ status: 409, code: 'not_trialing' });

    await pricing.addDiscountCode(admin, {
      code: 'PILOT50',
      kind: 'percentage',
      percentBps: 5_000,
      months: 2,
    });
    const coded = await companies.applyCode(admin, id, 'pilot50');
    expect(coded.subscription.discount?.code).toBe('PILOT50');
    expect(await refusal(companies.setTier(outsider, id, 'growth', 'Not allowed here'))).toEqual({
      status: 403,
      code: 'forbidden',
    });
  });

  it('shows whether a support grant is active, and the grants on the company page', async () => {
    const made = await companies.createCompany(admin, {
      kind: 'agency',
      name: 'Grant Agency',
      tier: 'growth',
      adminName: 'Akua Grant',
      adminEmail: 'akua@grant.invalid',
    });
    const companyAdmin = await withCompany(
      ctx.database,
      { companyId: made.company.id, actorKind: 'system' },
      async (tx) =>
        (
          await tx.execute<{ id: string; person_id: string }>(
            sql`select id, person_id from membership`,
          )
        ).rows[0]!,
    );
    const granted = await support.grant(
      {
        kind: 'staff',
        personId: companyAdmin.person_id,
        companyId: made.company.id,
        companyKind: 'agency',
        membershipId: companyAdmin.id,
        role: 'agency_admin',
        nominatedApprover: false,
        scope: {},
        authMethod: 'password_totp',
      },
      { reason: 'Please check our invoice' },
    );
    const detail = await companies.company(admin, made.company.id);
    expect(detail.supportGrantActive).toBe(true);
    expect(detail.supportGrants.map((g) => g.id)).toEqual([granted.id]);
    expect(await refusal(companies.company(admin, '019a3000-0000-7000-8000-00000000beef'))).toEqual(
      { status: 404, code: 'not_found' },
    );
  });
});
