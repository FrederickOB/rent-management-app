import { sql, withCompany } from '@rent/db';
import type { Actor } from '@rent/domain/policy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupportAccessService } from '../src/admin/support.service';
import { PolicyService } from '../src/policy/policy.service';
import { company, member, person, staff, startServerTest, type ServerTestContext } from './support';

/**
 * AD-10, M11 (coordinator follow-up 3): a platform admin may end a company's support grant early:
 * the platform's own access only, with a reason, audited in the platform's chain and the
 * company's. Only the company's admins can grant; once ended, the platform sees nothing there.
 */
let ctx: ServerTestContext;
let support: SupportAccessService;
let platformId: string;
let landlordId: string;
let admin: Extract<Actor, { kind: 'platform_admin' }>;
let owner: Extract<Actor, { kind: 'staff' }>;
const REASON = 'The customer’s question is answered; closing access';

/** A company's chain, as its system sees it: the events with this action. */
async function events(companyId: string, action: string) {
  return withCompany(
    ctx.database,
    { companyId, actorKind: 'system' },
    async (tx) =>
      (
        await tx.execute<{
          actor_kind: string;
          actor_person_id: string | null;
          record_id: string | null;
          data: Record<string, unknown>;
        }>(
          sql`select actor_kind, actor_person_id, record_id, data from audit_event
            where action = ${action} order by seq`,
        )
      ).rows,
  );
}

beforeAll(async () => {
  ctx = await startServerTest();
  support = new SupportAccessService(ctx.database, new PolicyService(), ctx.audit);
  platformId = await company(ctx, 'platform', 'Rent Platform');
  landlordId = await company(ctx, 'landlord', 'Support End Landlord');
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
});

afterAll(async () => {
  await ctx?.close();
});

describe('AD-10 a platform admin ends its own support access early (M11)', () => {
  it('ends the active grant with a reason, audited in both chains; then the company is closed to the platform', async () => {
    const grant = await support.grant(owner, {
      reason: 'Help with the owner statement',
      hours: 24,
    });
    await support.overview(admin, landlordId);

    // Refusals first: a staff member, a short reason, a malformed company.
    await expect(support.endGrant(owner, landlordId, REASON)).rejects.toMatchObject({
      status: 403,
    });
    await expect(support.endGrant(admin, landlordId, 'no')).rejects.toMatchObject({
      code: 'support_reason',
    });
    await expect(support.endGrant(admin, 'nope', REASON)).rejects.toMatchObject({
      code: 'support_no_grant',
    });

    const ended = await support.endGrant(admin, landlordId, `  ${REASON}  `);
    expect(ended).toMatchObject({
      id: grant.id,
      active: false,
      revokedByName: 'Ama Support (platform)',
    });
    expect(ended.revokedAt).toBeInstanceOf(Date);
    expect(ended.sessions).toHaveLength(1);

    // Closed: the support path refuses, and the platform admin's own context sees nothing.
    await expect(support.overview(admin, landlordId)).rejects.toMatchObject({
      code: 'support_no_grant',
    });
    const seen = await withCompany(
      ctx.database,
      { companyId: landlordId, personId: admin.personId, actorKind: 'platform_admin' },
      (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from support_grant`),
    );
    expect(seen.rows[0]!.n).toBe(0);
    // Ending again: nothing active to end.
    await expect(support.endGrant(admin, landlordId, REASON)).rejects.toMatchObject({
      code: 'support_no_grant',
    });

    // The company sees the grant revoked by the platform admin, as its own revocations are shown.
    const [listed] = await support.list(owner);
    expect(listed).toMatchObject({
      id: grant.id,
      active: false,
      revokedByName: 'Ama Support (platform)',
    });

    // NFR-AUDIT: the company's chain (the semantic event and the row's change) and the platform's.
    const company = await events(landlordId, 'support.ended_by_platform');
    expect(company).toEqual([
      {
        actor_kind: 'system',
        actor_person_id: admin.personId,
        record_id: grant.id,
        data: { reason: REASON, by: 'platform_admin' },
      },
    ]);
    const row = await events(landlordId, 'support_grant.update');
    expect(row.at(-1)).toMatchObject({ actor_person_id: admin.personId, record_id: grant.id });
    const platformEvents = await events(platformId, 'support.ended');
    expect(platformEvents).toEqual([
      {
        actor_kind: 'platform_admin',
        actor_person_id: admin.personId,
        record_id: grant.id,
        data: { companyId: landlordId, reason: REASON },
      },
    ]);
    expect((await ctx.audit.verifyChain(landlordId)).ok).toBe(true);
    expect((await ctx.audit.verifyChain(platformId)).ok).toBe(true);
  });

  it('only the company grants: a platform admin can only end, and a company without a grant is refused', async () => {
    await expect(
      support.grant(admin as unknown as Actor, { reason: 'Platform granting itself access' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(support.endGrant(admin, landlordId, REASON)).rejects.toMatchObject({
      status: 403,
      code: 'support_no_grant',
    });
  });

  it('why the revocation runs as the system path: in the admin’s own context the row’s audit cannot be written', async () => {
    const grant = await support.grant(owner, { reason: 'Second look at the statement', hours: 1 });
    await expect(
      withCompany(
        ctx.database,
        { companyId: landlordId, personId: admin.personId, actorKind: 'platform_admin' },
        (tx) =>
          tx.execute(
            sql`update support_grant set revoked_at = now(), revoked_by = ${admin.personId}::uuid
                where id = ${grant.id}::uuid`,
          ),
      ),
    ).rejects.toMatchObject({ cause: { code: 'RA002' } });
    // Nothing changed: the grant is still active and ends as designed.
    expect((await support.endGrant(admin, landlordId, REASON)).id).toBe(grant.id);
  });
});
