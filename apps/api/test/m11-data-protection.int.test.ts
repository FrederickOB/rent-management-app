import { schema, sql, withCompany } from '@rent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  enrolStaff,
  startApi,
  superuser,
  type Device,
  type TestApi,
} from './support';

/**
 * The M11 data protection and Gate 1 routes over HTTP (decisions 4 and 5): the contract's outputs
 * as the services give them (a `data_protection` consent source included), Idempotency-Key on
 * erasure, the platform's retention review and Gate 1 trend and export, and a staff member's day
 * recorded from their requests by the guard, in the background.
 */
const PASSWORD = 'correct horse battery staple';

let api: TestApi;
let agencyId: string;
let admin: Device;
let adminPerson: string;
let manager: Device;
let platformAdmin: Device;
let tenantId: string;
const today = new Date().toISOString().slice(0, 10);

async function signedIn(
  email: string,
  role: 'agency_admin' | 'property_manager' | 'platform_admin',
  companyId: string,
) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, role);
  return { device: (await enrolStaff(api, email, PASSWORD)).device, personId };
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  agencyId = await createCompany(api, 'agency', 'Privacy Routes Agency');
  const platformId = await createCompany(api, 'platform', 'Platform');
  const a = await signedIn('admin@privacy.invalid', 'agency_admin', agencyId);
  admin = a.device;
  adminPerson = a.personId;
  manager = (await signedIn('manager@privacy.invalid', 'property_manager', agencyId)).device;
  platformAdmin = (await signedIn('platform@privacy.invalid', 'platform_admin', platformId)).device;
  tenantId = await withCompany(
    api.database,
    { companyId: agencyId, actorKind: 'system' },
    async (tx) => {
      const [row] = await tx
        .insert(schema.tenant)
        .values({
          companyId: agencyId,
          kind: 'individual',
          displayName: 'Route Tenant',
          phone: '+233241119001',
        })
        .returning({ id: schema.tenant.id });
      return row!.id;
    },
  );
});

afterAll(async () => {
  await api?.close();
});

describe('NFR-DP CM-09 the data protection routes (API)', () => {
  it('records an erasure request, stops messaging, and erases only with an Idempotency-Key', async () => {
    expect((await admin.call('/data-protection/requests')).json).toEqual([]);
    expect((await manager.call('/data-protection/requests')).status).toBe(403);
    const made = await admin.call('/data-protection/requests', {
      body: { tenantId, kind: 'erasure', receivedOn: today, notes: 'By phone' },
    });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({
      tenant: { id: tenantId, name: 'Route Tenant' },
      kind: 'erasure',
      dueOn: null,
      dueRuleUnverified: true,
      status: 'received',
      messagingStopped: true,
      export: null,
      createdAt: expect.any(String),
      completedAt: null,
    });
    const id = String(made.json.id);
    // The consent card shows the withdrawals, with their new source.
    const consent = await admin.call(`/tenants/${tenantId}/messaging-consent`);
    expect(consent.status).toBe(200);
    const channels = (
      consent.json.subjects as {
        channels: { channel: string; granted: boolean; source: string }[];
      }[]
    )[0]!.channels;
    expect(channels.find((c) => c.channel === 'sms')).toMatchObject({
      granted: false,
      source: 'data_protection',
    });

    const noKey = await admin.call(`/data-protection/requests/${id}/erase`, { body: {} });
    expect(noKey.status).toBe(400);
    const erased = await admin.call(`/data-protection/requests/${id}/erase`, {
      body: {},
      headers: { 'idempotency-key': 'erase-route-0001' },
    });
    expect(erased.status).toBe(200);
    expect(erased.json).toMatchObject({ status: 'in_progress', anonymised: [] });
    expect(erased.json.held).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'tenant_profile', records: 1, until: null }),
      ]),
    );
    const replay = await admin.call(`/data-protection/requests/${id}/erase`, {
      body: {},
      headers: { 'idempotency-key': 'erase-route-0001' },
    });
    expect(replay.json).toEqual(erased.json);
    const closed = await admin.call(`/data-protection/requests/${id}`, {
      body: { status: 'refused', outcome: 'Not the tenant asking' },
    });
    expect(closed.json).toMatchObject({ status: 'refused', completedAt: expect.any(String) });
    const again = await admin.call(`/data-protection/requests/${id}`, {
      body: { status: 'completed', outcome: 'x' },
    });
    expect(again.status).toBe(409);
  });

  it('prepares an access request’s export, and polls it', async () => {
    const made = await admin.call('/data-protection/requests', {
      body: { tenantId, kind: 'access', receivedOn: today },
    });
    const started = await admin.call(`/data-protection/requests/${String(made.json.id)}/export`, {
      body: {},
    });
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ status: 'preparing', url: null, expiresAt: null });
    const polled = await admin.call(`/data-protection/exports/${String(started.json.id)}`);
    expect(polled.json).toMatchObject({ id: started.json.id, status: 'preparing' });
    expect((await manager.call(`/data-protection/exports/${String(started.json.id)}`)).status).toBe(
      403,
    );
  });

  it('gives platform admins the retention review, nobody else', async () => {
    const review = await platformAdmin.call('/platform/retention');
    expect(review.status).toBe(200);
    expect(review.json).toMatchObject({ checkedAt: null });
    expect((review.json.categories as unknown[]).length).toBe(6);
    expect((await admin.call('/platform/retention')).status).toBe(403);
  });
});

describe('DA-01 DA-06 Gate 1 trend and export routes (API)', () => {
  it('serves the company and platform trends and the platform export', async () => {
    const trend = await admin.call('/metrics/gate1/trend');
    expect(trend.status).toBe(200);
    expect(trend.json.months).toEqual(expect.any(Array));
    const platform = await platformAdmin.call('/platform/metrics/gate1/trend');
    expect(platform.status).toBe(200);
    const bad = await platformAdmin.call('/platform/metrics/gate1/trend?from=2020-01&to=2026-01');
    expect(bad.status).toBe(400);
    const exported = await platformAdmin.call('/platform/metrics/gate1/export', { body: {} });
    expect(exported.status).toBe(200);
    expect(exported.json).toMatchObject({ url: expect.any(String), expiresAt: expect.any(String) });
    expect((await admin.call('/platform/metrics/gate1/export', { body: {} })).status).toBe(403);
  });

  it('records the staff member’s active day from their requests, once', async () => {
    let rows: { n: number }[] = [];
    for (let i = 0; i < 50; i += 1) {
      rows = (await superuser(
        api,
        `select count(*)::int as n from staff_active_day where person_id = $1`,
        [adminPerson],
      )) as { n: number }[];
      if (rows[0]?.n === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(rows[0]?.n).toBe(1);
    const platformDays = await withCompany(
      api.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from staff_active_day`),
    );
    // The agency admin and the manager; never the platform admin.
    expect(platformDays.rows[0]!.n).toBe(2);
  });
});
