import { sql, withCompany, withSystem } from '@rent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * M10 review BE-11: M6's `PUT /platform/companies/{id}/plan` sets the subscription's tier and the
 * company's plan together, audited with a reason, as the console's setTier does; a plan the
 * company already has changes nothing.
 */
const PASSWORD = 'correct horse battery staple';
let api: TestApi;
let platformAdmin: Device;
let agencyId: string;

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  const platformId = await createCompany(api, 'platform', 'Platform');
  agencyId = await createCompany(api, 'agency', 'Plans Agency');
  const { personId } = await createPerson(api, {
    name: 'platform@plans.invalid',
    email: 'platform@plans.invalid',
    password: PASSWORD,
  });
  await addMembership(api, platformId, personId, 'platform_admin');
  platformAdmin = (await enrolStaff(api, 'platform@plans.invalid', PASSWORD)).device;
}, 120_000);

afterAll(async () => {
  await api?.close();
});

async function state() {
  return withSystem(api.database, {}, async (tx) => {
    const company = await tx.execute<{ plan: string }>(
      sql`select plan from app.subscriber_companies() where company_id = ${agencyId}::uuid`,
    );
    return company.rows[0]!.plan;
  });
}

describe('BE-11 the M6 plan route sets the subscription tier with the plan', () => {
  it('changes both, audited with a reason, and a plan already held changes nothing', async () => {
    const set = await platformAdmin.call(`/platform/companies/${agencyId}/plan`, {
      method: 'PUT',
      body: { plan: 'starter' },
    });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ companyId: agencyId, plan: 'starter' });
    expect(await state()).toBe('starter');
    // Audited in the company's own chain, with the reason.
    const audited = await withCompany(
      api.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ data: { to: string; reason: string } }>(
          sql`select data from audit_event where action = 'subscription.tier_changed'`,
        ),
    );
    expect(audited.rows.map((r) => [r.data.to, r.data.reason])).toEqual([
      ['starter', 'Set on the company plans page'],
    ]);
    const again = await platformAdmin.call(`/platform/companies/${agencyId}/plan`, {
      method: 'PUT',
      body: { plan: 'starter' },
    });
    expect(again.status).toBe(200);
    expect(await state()).toBe('starter');
  });
});
