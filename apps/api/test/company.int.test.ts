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

const PASSWORD = 'correct horse battery staple';

let api: TestApi;
let admin: Device;
let manager: Device;
let accountant: Device;
let platformAdmin: Device;

async function signedIn(
  email: string,
  role: 'agency_admin' | 'property_manager' | 'accountant' | 'platform_admin',
  companyId: string,
) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  const agencyId = await createCompany(api, 'agency', 'Endpoint Agency');
  const platformId = await createCompany(api, 'platform', 'Platform');
  admin = await signedIn('admin@endpoints.invalid', 'agency_admin', agencyId);
  manager = await signedIn('manager@endpoints.invalid', 'property_manager', agencyId);
  accountant = await signedIn('accountant@endpoints.invalid', 'accountant', agencyId);
  platformAdmin = await signedIn('platform@endpoints.invalid', 'platform_admin', platformId);
});

afterAll(async () => {
  await api?.close();
});

describe('AD-01 company branding (API)', () => {
  it('shows the company profile and lets an admin change the branding', async () => {
    const profile = await admin.call('/company');
    expect(profile.status).toBe(200);
    expect(profile.json).toMatchObject({
      kind: 'agency',
      displayName: 'Endpoint Agency',
      settings: { advanceRentPolicy: 'off' },
    });
    const updated = await admin.call('/company/branding', {
      method: 'PATCH',
      body: { primaryColour: '#223344', senderName: 'Endpoint Ltd' },
    });
    expect(updated.status).toBe(200);
    expect(updated.json.branding).toMatchObject({
      primaryColour: '#223344',
      senderName: 'Endpoint Ltd',
    });
  });

  it('returns 403 to someone without the right and 400 for invalid input', async () => {
    expect(
      (
        await manager.call('/company/branding', {
          method: 'PATCH',
          body: { senderName: 'Nope Ltd' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await admin.call('/company/branding', { method: 'PATCH', body: { primaryColour: 'blue' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await admin.call('/company/settings', {
          method: 'PATCH',
          body: { advanceRentPolicy: 'sometimes' },
        })
      ).status,
    ).toBe(400);
  });

  it('issues a presigned logo upload only for an accepted type and size', async () => {
    const ok = await admin.call('/company/logo/uploads', {
      body: { contentType: 'image/png', sizeBytes: 2048 },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ uploadId: expect.any(String), url: expect.any(String) });
    expect(
      (
        await admin.call('/company/logo/uploads', {
          body: { contentType: 'image/svg+xml', sizeBytes: 2048 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin.call('/company/logo/uploads', {
          body: { contentType: 'image/png', sizeBytes: 5_000_000 },
        })
      ).status,
    ).toBe(400);
  });
});

describe('AD-03 users and roles (API)', () => {
  it('lists people for admins and managers, and refuses an accountant', async () => {
    const list = await admin.call('/memberships');
    expect(list.status).toBe(200);
    expect((list.json as unknown as { role: string }[]).map((m) => m.role).sort()).toEqual([
      'accountant',
      'agency_admin',
      'property_manager',
    ]);
    expect((await manager.call('/memberships')).status).toBe(200);
    expect((await accountant.call('/memberships')).status).toBe(403);
  });

  it('invites a caretaker by phone and refuses a manager inviting anyone', async () => {
    const invited = await admin.call('/memberships', {
      body: { name: 'Gate Caretaker', phone: '020 000 0499', role: 'caretaker' },
    });
    expect(invited.status).toBe(200);
    expect(invited.json).toMatchObject({ role: 'caretaker', phoneMasked: '+233 ** *** 0499' });
    const refused = await manager.call('/memberships', {
      body: { name: 'Xavier', email: 'x@endpoints.invalid', role: 'accountant' },
    });
    expect(refused.status, JSON.stringify(refused.json)).toBe(403);
  });
});

describe('AD-07 audit search (API)', () => {
  it('finds the branding change with before and after values, and refuses a manager', async () => {
    const result = await admin.call('/audit-events?action=company.update&limit=5');
    expect(result.status).toBe(200);
    const events = (
      result.json as unknown as {
        events: {
          action: string;
          data: { before: Record<string, unknown>; after: Record<string, unknown> };
        }[];
      }
    ).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.data.after.primary_colour === '#223344')).toBe(true);
    expect((await accountant.call('/audit-events')).status).toBe(200);
    expect((await manager.call('/audit-events')).status).toBe(403);
  });
});

describe('TX-08 rules engine (API)', () => {
  it('shows platform admins the rules in force with their warnings, and nobody else', async () => {
    const result = await platformAdmin.call('/rules?country=GH');
    expect(result.status).toBe(200);
    const rules = result.json as unknown as {
      key: string;
      verificationStatus: string;
      warning: boolean;
    }[];
    expect(rules.find((r) => r.key === 'rent_tax.base')).toMatchObject({
      verificationStatus: 'unverified',
      warning: true,
    });
    expect((await admin.call('/rules')).status).toBe(403);
  });
});
