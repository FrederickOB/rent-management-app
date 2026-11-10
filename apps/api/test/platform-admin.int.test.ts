import type { AlertPort } from '@rent/integrations';
import { ALERT_PORT } from '@rent/server/core';
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
 * AD-10 over HTTP (M10 decisions 13 to 16): the platform admin console's routes for platform
 * admins only, the contract's errors, support access from both sides, onboarding with its
 * invitation email, and alerts stored by the API's own alert port.
 */
const PASSWORD = 'correct horse battery staple';

let api: TestApi;
let platformId: string;
let agencyId: string;
let platformAdmin: Device;
let agencyAdmin: Device;

const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function signedIn(
  email: string,
  role: 'agency_admin' | 'platform_admin',
  companyId: string,
): Promise<Device> {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  platformId = await createCompany(api, 'platform', 'Platform');
  agencyId = await createCompany(api, 'agency', 'Route Agency');
  platformAdmin = await signedIn('platform@console.invalid', 'platform_admin', platformId);
  agencyAdmin = await signedIn('admin@route-agency.invalid', 'agency_admin', agencyId);
});

afterAll(async () => {
  await api?.close();
});

describe('AD-10 the platform admin console (API)', () => {
  it('serves every console read to platform admins only', async () => {
    for (const path of [
      '/platform/companies',
      '/platform/price-lists',
      '/platform/terms',
      '/platform/discount-codes',
      '/platform/whatsapp-rates',
      '/platform/usage',
      '/platform/health',
      '/platform/support-grants',
      '/rules/history',
    ]) {
      expect((await platformAdmin.call(path)).status, path).toBe(200);
      expect((await agencyAdmin.call(path)).status, path).toBe(403);
    }
    const lists = (await platformAdmin.call('/platform/price-lists')).json as unknown as {
      placeholder: boolean;
    }[];
    expect(lists.filter((l) => l.placeholder)).toHaveLength(3);
    const rules = (await platformAdmin.call('/rules/history?key=rent_tax.rate.residential'))
      .json as unknown as { state: string }[];
    expect(rules.map((r) => r.state)).toEqual(['in_force']);
  });

  it('answers with the contract’s errors', async () => {
    const priceList = (effectiveFrom: string) => ({
      tier: 'starter',
      ratesMinor: { single_room: 600, self_contained: 1100, commercial: 2100 },
      minimumMinor: 6000,
      annualDiscountBps: 1000,
      effectiveFrom,
    });
    const past = await platformAdmin.call('/platform/price-lists', { body: priceList(isoDay(0)) });
    expect(past.status).toBe(400);
    expect(past.json.code).toBe('EFFECTIVE_FROM_PAST');
    const added = await platformAdmin.call('/platform/price-lists', { body: priceList(isoDay(2)) });
    expect(added.status).toBe(200);
    expect(added.json).toMatchObject({ tier: 'starter', placeholder: false });

    const code = { code: 'ROUTE10', kind: 'percentage', percentBps: 1000, months: 1 };
    expect((await platformAdmin.call('/platform/discount-codes', { body: code })).status).toBe(200);
    const taken = await platformAdmin.call('/platform/discount-codes', { body: code });
    expect(taken.status).toBe(409);
    expect(taken.json.code).toBe('DISCOUNT_CODE_TAKEN');

    const badRule = await platformAdmin.call('/rules', {
      body: {
        key: 'rent_tax.due_days_after_receipt',
        value: { days: 'thirty' },
        effectiveFrom: isoDay(30),
        source: 'A test',
        verificationStatus: 'unverified',
      },
    });
    expect(badRule.status).toBe(400);
    expect(badRule.json.code).toBe('RULE_VALUE');
    expect(
      (
        await agencyAdmin.call('/rules', {
          body: {
            key: 'rent_tax.due_days_after_receipt',
            value: { days: 30 },
            effectiveFrom: isoDay(30),
            source: 'A test',
            verificationStatus: 'unverified',
          },
        })
      ).status,
    ).toBe(403);
  });

  it('lists the alerts the API’s own alert port raised, stored as decision 15 asks', async () => {
    await api.app.get<AlertPort>(ALERT_PORT).raise({
      severity: 'warning',
      code: 'm10.route_alert',
      message: 'A test alert',
      context: { companyId: agencyId },
    });
    const health = await platformAdmin.call('/platform/health');
    expect(health.status).toBe(200);
    const alerts = health.json.recentAlerts as unknown as { code: string; companyId: string }[];
    expect(alerts[0]).toMatchObject({ code: 'm10.route_alert', companyId: agencyId });
  });
});

describe('AD-10 support access (API)', () => {
  it('is granted by the company, used read-only by support, audited, and revoked', async () => {
    const closed = await platformAdmin.call(`/platform/support/${agencyId}`);
    expect(closed.status).toBe(403);
    expect(closed.json.code).toBe('SUPPORT_NO_GRANT');

    const granted = await agencyAdmin.call('/support-grants', {
      body: { reason: 'Our statement does not add up', hours: 4 },
    });
    expect(granted.status).toBe(200);
    expect(granted.json).toMatchObject({ active: true, revokedAt: null, sessions: [] });
    const grantId = String(granted.json.id);

    const open = await platformAdmin.call(`/platform/support/${agencyId}`);
    expect(open.status).toBe(200);
    expect(open.json).toMatchObject({
      company: { id: agencyId, name: 'Route Agency' },
      grant: { id: grantId, reason: 'Our statement does not add up' },
      counts: { properties: 0, units: 0, leases: 0, tenants: 0, openApprovals: 0 },
    });

    const mine = (await agencyAdmin.call('/support-grants')).json as unknown as {
      id: string;
      sessions: { adminName: string; route: string }[];
    }[];
    expect(mine[0]!.id).toBe(grantId);
    expect(mine[0]!.sessions).toEqual([
      expect.objectContaining({
        adminName: 'platform@console.invalid',
        route: 'platformAdmin.supportOverview',
      }),
    ]);
    const across = (await platformAdmin.call('/platform/support-grants')).json as unknown as {
      id: string;
      company: { id: string };
      active: boolean;
    }[];
    expect(across.map((g) => [g.id, g.company.id, g.active])).toEqual([[grantId, agencyId, true]]);

    const revoked = await agencyAdmin.call(`/support-grants/${grantId}/revoke`, {
      method: 'POST',
      body: {},
    });
    expect(revoked.status).toBe(200);
    expect(revoked.json).toMatchObject({ active: false });
    const after = await platformAdmin.call(`/platform/support/${agencyId}`);
    expect(after.status).toBe(403);
    expect(after.json.code).toBe('SUPPORT_NO_GRANT');
    // A platform admin never grants; a company admin never uses it.
    expect(
      (await platformAdmin.call('/support-grants', { body: { reason: 'Let me in please' } }))
        .status,
    ).toBe(403);
    expect((await agencyAdmin.call(`/platform/support/${agencyId}`)).status).toBe(403);
  });
});

describe('AD-10 onboarding (API, decision 14)', () => {
  it('creates a company in trial and emails its first admin the set-password invitation', async () => {
    const created = await platformAdmin.call('/platform/companies', {
      body: {
        kind: 'agency',
        name: 'Onboarded Agency',
        tier: 'starter',
        trialDays: 30,
        adminName: 'Kobby Onboarded',
        adminEmail: 'kobby@onboarded.invalid',
      },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(created.json).toMatchObject({
      company: { name: 'Onboarded Agency' },
      kind: 'agency',
      tier: 'starter',
      status: 'trialing',
    });
    const invitation = api.email.sent.find((m) => m.to === 'kobby@onboarded.invalid');
    expect(invitation?.text ?? '').toContain('accept-invite');
    const companyId = String((created.json.company as { id: string }).id);
    const list = (await platformAdmin.call('/platform/companies')).json as unknown as {
      company: { id: string };
    }[];
    expect(list.map((c) => c.company.id)).toContain(companyId);
    const detail = await platformAdmin.call(`/platform/companies/${companyId}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ subscription: { tier: 'starter' }, invoices: [] });
    expect(
      (
        await agencyAdmin.call('/platform/companies', {
          body: {
            kind: 'agency',
            name: 'Not Allowed',
            tier: 'starter',
            adminName: 'Not Allowed',
            adminEmail: 'no@allowed.invalid',
          },
        })
      ).status,
    ).toBe(403);
  });
});
