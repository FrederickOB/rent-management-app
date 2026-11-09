import { sql, withCompany, type Tx } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { sqlState } from '@rent/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupportAccessService } from '../src/admin/support.service';
import { AppError } from '../src/core/errors';
import { PolicyService } from '../src/policy/policy.service';
import { company, member, person, staff, startServerTest, type ServerTestContext } from './support';

/**
 * ★ AD-10 (M10 decision 13; plan section 6): support access without the customer's recorded
 * consent is refused by the API and by the database when the code is bypassed; with a grant it is
 * read-only and audited in the customer's chain; it ends at expiry and at revocation; and a
 * company's own admins grant, list and revoke it (allowed while read-only). Real PostgreSQL with
 * RLS forced; the database guard's sweep of every table is in packages/db/src/support-guard.
 */
let ctx: ServerTestContext;
let support: SupportAccessService;
let platformId: string;
let landlordId: string;
let agencyId: string;
let admin: Extract<Actor, { kind: 'platform_admin' }>;
let owner: Extract<Actor, { kind: 'staff' }>;
let manager: Extract<Actor, { kind: 'staff' }>;
let agencyAdmin: Extract<Actor, { kind: 'staff' }>;

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

/** The customer's own chain: events with an action, as the company's system sees them. */
async function events(companyId: string, action: string) {
  return withCompany(ctx.database, { companyId, actorKind: 'system' }, async (tx) => {
    const rows = await tx.execute<{
      actor_kind: string;
      actor_person_id: string | null;
      record_type: string | null;
      record_id: string | null;
      data: Record<string, unknown>;
    }>(
      sql`select actor_kind, actor_person_id, record_type, record_id, data from audit_event
          where action = ${action} order by seq`,
    );
    return rows.rows;
  });
}

/** What a platform admin's own context sees in a company when code goes around the service. */
async function rawAsPlatformAdmin(companyId: string) {
  return withCompany(
    ctx.database,
    { companyId, personId: admin.personId, actorKind: 'platform_admin' },
    async (tx) => {
      const count = async (table: string) =>
        Number(
          (await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))
            .rows[0]!.n,
        );
      return {
        company: await count('company'),
        membership: await count('membership'),
        audit_event: await count('audit_event'),
        support_grant: await count('support_grant'),
      };
    },
  );
}

beforeAll(async () => {
  ctx = await startServerTest();
  support = new SupportAccessService(ctx.database, new PolicyService(), ctx.audit);
  platformId = await company(ctx, 'platform', 'Rent Platform');
  landlordId = await company(ctx, 'landlord', 'Support Landlord');
  agencyId = await company(ctx, 'agency', 'Support Agency');
  const adminPerson = await person(ctx, 'Ama Support (platform)');
  admin = {
    kind: 'platform_admin',
    personId: adminPerson,
    companyId: platformId,
    membershipId: await member(ctx, platformId, adminPerson, 'platform_admin'),
    authMethod: 'password_totp',
  };
  const ownerPerson = await person(ctx, 'Kofi Landlord');
  owner = staff(
    landlordId,
    'landlord',
    ownerPerson,
    await member(ctx, landlordId, ownerPerson, 'owner'),
    'owner',
  );
  const managerPerson = await person(ctx, 'Efua Manager');
  manager = staff(
    landlordId,
    'landlord',
    managerPerson,
    await member(ctx, landlordId, managerPerson, 'property_manager'),
    'property_manager',
  );
  const agencyPerson = await person(ctx, 'Yaw Agency Admin');
  agencyAdmin = staff(
    agencyId,
    'agency',
    agencyPerson,
    await member(ctx, agencyId, agencyPerson, 'agency_admin'),
    'agency_admin',
  );
});

afterAll(async () => {
  await ctx?.close();
});

describe('AD-10 support access', () => {
  it('★ refuses support access without consent, by the API and by the database', async () => {
    let ran = false;
    expect(
      await refusal(
        support.withSupport(admin, landlordId, 'test.read', null, async () => {
          ran = true;
        }),
      ),
    ).toEqual({ status: 403, code: 'support_no_grant' });
    expect(ran).toBe(false);
    expect(await refusal(support.overview(admin, landlordId))).toEqual({
      status: 403,
      code: 'support_no_grant',
    });
    // The code bypassed: the platform admin's own context sees nothing of the company.
    expect(await rawAsPlatformAdmin(landlordId)).toEqual({
      company: 0,
      membership: 0,
      audit_event: 0,
      support_grant: 0,
    });
    // And nothing was written in the customer's chain.
    expect(await events(landlordId, 'support.request')).toEqual([]);
  });

  it('is granted by the company’s own admins only, for a reason and at most 7 days', async () => {
    expect(await refusal(support.grant(manager, { reason: 'Receipt missing' }))).toEqual({
      status: 403,
      code: 'forbidden',
    });
    expect(await refusal(support.list(manager))).toEqual({ status: 403, code: 'forbidden' });
    expect(await refusal(support.grant(owner, { reason: 'Fix' }))).toEqual({
      status: 400,
      code: 'support_reason',
    });
    expect(await refusal(support.grant(owner, { reason: 'Receipt missing', hours: 169 }))).toEqual({
      status: 400,
      code: 'support_hours',
    });
    expect(await refusal(support.grant(admin, { reason: 'Receipt missing' }))).toEqual({
      status: 403,
      code: 'forbidden',
    });
    // Allowed while read-only (decision 11): granting support access always works.
    const granted = await support.grant(
      { ...agencyAdmin, subscriptionAccess: 'read_only' },
      { reason: 'The owner statement looks wrong', hours: 2 },
    );
    expect(granted).toMatchObject({
      reason: 'The owner statement looks wrong',
      grantedBy: { personId: agencyAdmin.personId, name: 'Yaw Agency Admin' },
      revokedAt: null,
      revokedByName: null,
      active: true,
      sessions: [],
    });
    expect(granted.until.getTime() - granted.from.getTime()).toBe(2 * 3_600_000);
    await support.revoke(agencyAdmin, granted.id);
  });

  it('with a grant opens the company read-only, audits each request in its chain, and lists it', async () => {
    const granted = await support.grant(owner, { reason: 'A tenant cannot see a receipt' });
    expect(granted.until.getTime() - granted.from.getTime()).toBe(24 * 3_600_000);
    expect((await events(landlordId, 'support.granted'))[0]).toMatchObject({
      actor_kind: 'staff',
      actor_person_id: owner.personId,
      record_type: 'support_grant',
      record_id: granted.id,
    });

    const overview = await support.overview(admin, landlordId, 'req-1');
    expect(overview).toMatchObject({
      company: { id: landlordId, name: 'Support Landlord' },
      grant: { id: granted.id, reason: 'A tenant cannot see a receipt' },
      counts: { properties: 0, units: 0, leases: 0, tenants: 0, openApprovals: 0 },
      recentPayments: [],
    });
    expect(overview.recentAudit.map((e) => e.action)).toContain('support.request');

    // Read-only: a write fails, and the request is audited all the same.
    expect(
      await sqlState(
        support.withSupport(admin, landlordId, 'test.write', 'processed_job', (tx: Tx) =>
          tx.execute(
            sql`insert into processed_job (company_id, key, job_name)
                values (${landlordId}::uuid, 'by-support', 'test')`,
          ),
        ),
      ),
    ).toBe('25006');

    const requests = await events(landlordId, 'support.request');
    expect(requests).toEqual([
      {
        actor_kind: 'platform_admin',
        actor_person_id: admin.personId,
        record_type: 'support_grant',
        record_id: granted.id,
        data: { grantId: granted.id, route: 'platformAdmin.supportOverview', record: null },
      },
      {
        actor_kind: 'platform_admin',
        actor_person_id: admin.personId,
        record_type: 'support_grant',
        record_id: granted.id,
        data: { grantId: granted.id, route: 'test.write', record: 'processed_job' },
      },
    ]);

    // The company sees each request (who, which route, which record, when).
    const [mine] = await support.list(owner);
    expect(mine!.id).toBe(granted.id);
    expect(mine!.sessions.map((s) => [s.adminName, s.route, s.record])).toEqual([
      ['Ama Support (platform)', 'test.write', 'processed_job'],
      ['Ama Support (platform)', 'platformAdmin.supportOverview', null],
    ]);
    // So does the console, across companies, without entering any.
    const all = await support.grantsAcrossCompanies(admin);
    const listed = all.find((g) => g.id === granted.id)!;
    expect(listed.company).toEqual({ id: landlordId, name: 'Support Landlord' });
    expect(listed.active).toBe(true);
    expect(listed.sessions).toHaveLength(2);
    expect((await support.grantsAcrossCompanies(admin, true)).map((g) => g.id)).toEqual([
      granted.id,
    ]);
    expect(await support.companiesWithActiveGrant(admin)).toEqual(new Set([landlordId]));

    // The grant is the company's own: the agency is still closed.
    expect(await refusal(support.overview(admin, agencyId))).toEqual({
      status: 403,
      code: 'support_no_grant',
    });
    // Nobody else uses support access.
    expect(await refusal(support.overview(owner, landlordId))).toEqual({
      status: 403,
      code: 'forbidden',
    });
    expect(await refusal(support.grantsAcrossCompanies(agencyAdmin))).toEqual({
      status: 403,
      code: 'forbidden',
    });

    // Revoked: it ends at once, for the API and the database, and is revoked once only.
    const revoked = await support.revoke(owner, granted.id, 'req-2');
    expect(revoked).toMatchObject({ active: false, revokedByName: 'Kofi Landlord' });
    expect(revoked.sessions).toHaveLength(2);
    expect(await refusal(support.overview(admin, landlordId))).toEqual({
      status: 403,
      code: 'support_no_grant',
    });
    expect((await rawAsPlatformAdmin(landlordId)).membership).toBe(0);
    expect(await refusal(support.revoke(owner, granted.id))).toEqual({
      status: 409,
      code: 'support_grant_revoked',
    });
    expect(await refusal(support.revoke(owner, '019a3000-0000-7000-8000-00000000dead'))).toEqual({
      status: 404,
      code: 'not_found',
    });
    expect((await events(landlordId, 'support.revoked'))[0]).toMatchObject({
      actor_person_id: owner.personId,
      record_id: granted.id,
    });
  });

  it('ends at the grant’s expiry', async () => {
    const expired = await withCompany(
      ctx.database,
      { companyId: landlordId, personId: owner.personId, actorKind: 'staff' },
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`insert into support_grant (company_id, granted_by, reason, starts_at, ends_at)
                values (${landlordId}::uuid, ${owner.personId}::uuid, 'Yesterday''s question',
                        now() - interval '25 hours', now() - interval '1 hour')
                returning id`,
          )
        ).rows[0]!.id,
    );
    expect(await refusal(support.overview(admin, landlordId))).toEqual({
      status: 403,
      code: 'support_no_grant',
    });
    expect((await rawAsPlatformAdmin(landlordId)).company).toBe(0);
    const listed = (await support.list(owner)).find((g) => g.id === expired)!;
    expect(listed).toMatchObject({ active: false, revokedAt: null });
  });

  it('leaves the company’s own staff and system seeing what they saw before', async () => {
    const live = await support.grant(owner, { reason: 'Checking the register' });
    try {
      for (const actorKind of ['staff', 'system'] as const) {
        const seen = await withCompany(
          ctx.database,
          { companyId: landlordId, personId: owner.personId, actorKind },
          async (tx) =>
            (
              await tx.execute<{ members: number; grants: number }>(
                sql`select (select count(*) from membership)::int as members,
                           (select count(*) from support_grant)::int as grants`,
              )
            ).rows[0]!,
        );
        expect(seen, actorKind).toEqual({ members: 2, grants: 3 });
      }
    } finally {
      await support.revoke(owner, live.id);
    }
  });
});
