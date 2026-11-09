import { sql, withSystem } from '@rent/db';
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
 * The web e2e specs' test control (M10; assumption A1 in apps/web/e2e/subscription-support.ts):
 * `POST /_test/subscriptions/{companyId}/invoice` exists only with E2E_TEST_CONTROLS=on, and only
 * a platform admin may call it. The config's refusal in production is a unit test
 * (src/admin/test-controls.test.ts).
 */
const PASSWORD = 'correct horse battery staple';
const running: TestApi[] = [];

async function stack(overrides: Parameters<typeof startApi>[0]) {
  const api = await startApi({ AUTH_RATE_LIMITS: 'off', ...overrides });
  running.push(api);
  const platformId = await createCompany(api, 'platform', 'Platform');
  // Founder answer Q1: nothing is invoiced until billing is on (setup only).
  await withSystem(api.database, {}, (tx) =>
    tx.execute(sql`select app.turn_on_billing('2026-01-01'::date, 'M10 test controls')`),
  );
  const agencyId = await createCompany(api, 'agency', 'Controls Agency');
  const signedIn = async (email: string, role: 'agency_admin' | 'platform_admin', id: string) => {
    const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
    await addMembership(api, id, personId, role);
    return (await enrolStaff(api, email, PASSWORD)).device;
  };
  return {
    agencyId,
    platformAdmin: await signedIn('platform@controls.invalid', 'platform_admin', platformId),
    agencyAdmin: await signedIn('admin@controls.invalid', 'agency_admin', agencyId),
  };
}

const force = (device: Device, companyId: string, body: unknown) =>
  device.call(`/_test/subscriptions/${companyId}/invoice`, { body });

afterAll(async () => {
  for (const api of running) await api.close();
});

describe('M10 e2e test controls (A1)', () => {
  it('do not exist without E2E_TEST_CONTROLS', async () => {
    const { agencyId, platformAdmin } = await stack({});
    expect((await force(platformAdmin, agencyId, { dueDaysAgo: 15 })).status).toBe(404);
  });

  it('with it on, force an overdue invoice for platform admins only', async () => {
    const { agencyId, platformAdmin, agencyAdmin } = await stack({ E2E_TEST_CONTROLS: 'on' });
    expect((await force(agencyAdmin, agencyId, { dueDaysAgo: 15 })).status).toBe(403);
    expect((await force(platformAdmin, agencyId, { dueDaysAgo: -1 })).status).toBe(400);
    expect((await force(platformAdmin, 'not-a-company', { dueDaysAgo: 1 })).status).toBe(400);
    const forced = await force(platformAdmin, agencyId, { dueDaysAgo: 15 });
    expect(forced.status, JSON.stringify(forced.json)).toBe(200);
    expect(forced.json).toEqual({
      id: expect.any(String),
      number: expect.stringMatching(/^SUB-\d{4}-\d{6,}$/),
      totalMinor: expect.any(Number),
    });
    // The company's subscription now shows the invoice, past due and read-only (grace 14 days).
    const view = await agencyAdmin.call('/subscription');
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ access: 'read_only' });
  });
});
