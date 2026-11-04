import type { Actor } from '@rent/domain/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompaniesService } from '../src/companies/companies.service';
import { EntitlementsService } from '../src/companies/entitlements.service';
import { DocumentsService } from '../src/documents/documents.service';
import { PolicyService } from '../src/policy/policy.service';
import { RulesService } from '../src/rules/rules.service';
import { company, member, person, staff, startServerTest, type ServerTestContext } from './support';

let ctx: ServerTestContext;
let entitlements: EntitlementsService;
let companies: CompaniesService;
let agencyId: string;
let landlordId: string;
let platformAdmin: Actor;
let agencyAdmin: ReturnType<typeof staff>;
let landlord: ReturnType<typeof staff>;

beforeAll(async () => {
  ctx = await startServerTest();
  const policy = new PolicyService();
  entitlements = new EntitlementsService(ctx.database, policy);
  companies = new CompaniesService(
    ctx.database,
    policy,
    new DocumentsService(
      ctx.database,
      ctx.storage,
      ctx.config,
      ctx.clock,
      ctx.audit,
      new RulesService(ctx.database),
    ),
  );
  const platformId = await company(ctx, 'platform', 'Platform');
  agencyId = await company(ctx, 'agency', 'Osu Properties');
  landlordId = await company(ctx, 'landlord', 'Kwame Mensah');
  const adminId = await person(ctx, 'Platform admin');
  platformAdmin = {
    kind: 'platform_admin',
    personId: adminId,
    companyId: platformId,
    membershipId: await member(ctx, platformId, adminId, 'platform_admin'),
    authMethod: 'password_totp',
  };
  const agencyAdminId = await person(ctx, 'Agency admin');
  agencyAdmin = staff(
    agencyId,
    'agency',
    agencyAdminId,
    await member(ctx, agencyId, agencyAdminId, 'agency_admin'),
    'agency_admin',
  );
  const landlordPerson = await person(ctx, 'Landlord');
  landlord = staff(
    landlordId,
    'landlord',
    landlordPerson,
    await member(ctx, landlordId, landlordPerson, 'owner'),
    'owner',
  );
});

afterAll(async () => {
  await ctx?.close();
});

describe('CM-05 and CM-08 plan entitlements (decision 9)', () => {
  it('keeps every company on Growth until a platform admin says otherwise', async () => {
    expect(await entitlements.has(agencyId, 'inbox')).toBe(true);
    expect(await entitlements.has(landlordId, 'broadcasts')).toBe(true);
    expect((await companies.profile(landlord)).plan).toBe('growth');
  });

  it('moves a company to Starter only for a platform admin, and Starter has no inbox or broadcasts', async () => {
    await expect(
      entitlements.setCompanyPlan(agencyAdmin, landlordId, 'starter'),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      entitlements.setCompanyPlan(landlord, landlordId, 'starter'),
    ).rejects.toMatchObject({
      status: 403,
    });
    const set = await entitlements.setCompanyPlan(platformAdmin, landlordId, 'starter');
    expect(set).toMatchObject({ companyId: landlordId, plan: 'starter', kind: 'landlord' });
    for (const feature of [
      'inbox',
      'broadcasts',
      'tenant_groups',
      'maintenance',
      'bot_full_menu',
    ] as const)
      expect(await entitlements.has(landlordId, feature), feature).toBe(false);
    await expect(entitlements.assert(landlordId, 'inbox')).rejects.toMatchObject({
      status: 403,
      code: 'not_on_plan',
    });
    expect(await entitlements.has(agencyId, 'inbox')).toBe(true);
    const profile = await companies.profile(landlord);
    expect(profile).toMatchObject({ plan: 'starter', features: [] });
    const plans = await entitlements.companyPlans(platformAdmin);
    expect(plans.map((p) => [p.displayName, p.plan])).toEqual(
      expect.arrayContaining([
        ['Kwame Mensah', 'starter'],
        ['Osu Properties', 'growth'],
      ]),
    );
    await expect(entitlements.companyPlans(agencyAdmin)).rejects.toMatchObject({ status: 403 });
  });

  it('gives the company settings the inbox response target and tags in force (decision 10)', async () => {
    const profile = await companies.profile(agencyAdmin);
    expect(profile.settings).toMatchObject({ inboxFirstResponseMinutes: 240 });
    expect(profile.settings.inboxTags?.length).toBeGreaterThan(0);
    const updated = await companies.updateSettings(agencyAdmin, { inboxFirstResponseMinutes: 120 });
    expect(updated.settings.inboxFirstResponseMinutes).toBe(120);
  });
});
