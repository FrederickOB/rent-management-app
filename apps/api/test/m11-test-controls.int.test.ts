import { schema, sql, withCompany } from '@rent/db';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  enrolStaff,
  startApi,
  type Device,
  type TestApi,
} from './support';

/**
 * M11 e2e test control (OQ-29 under founder D1): `POST /_test/approvals/{id}/end-cooling-off`
 * exists only with E2E_TEST_CONTROLS=on, is for platform admins, works only on the API's own
 * database, and leaves a single-user request ready for its initiator to self-confirm.
 */
const PASSWORD = 'correct horse battery staple';
const running: TestApi[] = [];

afterAll(async () => {
  for (const api of running) await api.close();
});

async function stack(controls: boolean) {
  const api = await startApi({
    AUTH_RATE_LIMITS: 'off',
    E2E_TEST_CONTROLS: controls ? 'on' : 'off',
  });
  running.push(api);
  const platformId = await createCompany(api, 'platform', 'Platform');
  const landlordId = await createCompany(api, 'landlord', 'Cooling Landlord');
  const signedIn = async (email: string, role: 'owner' | 'platform_admin', companyId: string) => {
    const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
    const membershipId = await addMembership(api, companyId, personId, role);
    return { personId, membershipId, device: (await enrolStaff(api, email, PASSWORD)).device };
  };
  const platformAdmin = await signedIn('platform@cooling.invalid', 'platform_admin', platformId);
  const owner = await signedIn('owner@cooling.invalid', 'owner', landlordId);
  const requestId = await withCompany(
    api.database,
    { companyId: landlordId, actorKind: 'system' },
    async (tx) => {
      const [row] = await tx
        .insert(schema.approvalRequest)
        .values({
          companyId: landlordId,
          actionType: 'membership.invite',
          subjectType: 'membership',
          subjectId: 'cooling-test',
          payload: {},
          payloadHash: 'h',
          initiatedBy: owner.personId,
          initiatorMembershipId: owner.membershipId,
          mode: 'single_user',
          status: 'cooling_off',
          coolingOffUntil: new Date(Date.now() + 24 * 3_600_000),
          expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
        })
        .returning({ id: schema.approvalRequest.id });
      return row!.id;
    },
  );
  return { api, landlordId, platformAdmin, owner, requestId };
}

const end = (device: Device, id: string) =>
  device.call(`/_test/approvals/${id}/end-cooling-off`, { body: {} });

describe('AD-05 OQ-29 the e2e control that ends a cooling-off (M11)', () => {
  it('does not exist without E2E_TEST_CONTROLS', async () => {
    const { platformAdmin, requestId } = await stack(false);
    expect((await end(platformAdmin.device, requestId)).status).toBe(404);
  });

  it('with it on, ends a single-user cooling-off for platform admins only, on its own database', async () => {
    const { api, landlordId, platformAdmin, owner, requestId } = await stack(true);
    // Without the owner URL of this very database, it refuses.
    expect((await end(platformAdmin.device, requestId)).status).toBe(409);
    (api.config as { E2E_DATABASE_OWNER_URL?: string }).E2E_DATABASE_OWNER_URL = api.db.ownerUrl;
    expect((await end(owner.device, requestId)).status).toBe(403);
    expect((await end(platformAdmin.device, 'not-a-uuid')).status).toBe(400);
    const ended = await end(platformAdmin.device, requestId);
    expect(ended.status, JSON.stringify(ended.json)).toBe(200);
    const [row] = await withCompany(
      api.database,
      { companyId: landlordId, actorKind: 'system' },
      (tx) =>
        tx
          .execute<{ past: boolean; status: string }>(
            sql`select cooling_off_until < now() as past, status from approval_request where id = ${requestId}::uuid`,
          )
          .then((r) => r.rows),
    );
    expect(row).toEqual({ past: true, status: 'cooling_off' });
    // The status check and forced RLS are back on afterwards.
    const [table] = await withCompany(
      api.database,
      { companyId: landlordId, actorKind: 'system' },
      (tx) =>
        tx
          .execute<{ forced: boolean; enabled: string }>(
            sql`select c.relforcerowsecurity as forced, t.tgenabled as enabled from pg_class c
              join pg_trigger t on t.tgrelid = c.oid and t.tgname = 'check_request_update'
              where c.relname = 'approval_request'`,
          )
          .then((r) => r.rows),
    );
    expect(table).toEqual({ forced: true, enabled: 'O' });
  });
});
