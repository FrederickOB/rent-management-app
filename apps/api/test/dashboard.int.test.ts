import { ReportingRollupService } from '@rent/server/reporting';
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
 * The M9 dashboard routes over HTTP (DA-01, DA-06, Gate 1, decision 14): the contract's outputs
 * as the services give them, the refusals, and the platform admin's view across companies.
 */
const PASSWORD = 'correct horse battery staple';

let api: TestApi;
let agencyId: string;
let admin: Device;
let caretaker: Device;
let platformAdmin: Device;

async function signedIn(
  email: string,
  role: 'agency_admin' | 'caretaker' | 'platform_admin',
  companyId: string,
) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  agencyId = await createCompany(api, 'agency', 'Dashboard Agency');
  const platformId = await createCompany(api, 'platform', 'Platform');
  admin = await signedIn('admin@dashboard.invalid', 'agency_admin', agencyId);
  caretaker = await signedIn('caretaker@dashboard.invalid', 'caretaker', agencyId);
  platformAdmin = await signedIn('platform@dashboard.invalid', 'platform_admin', platformId);
});

afterAll(async () => {
  await api?.close();
});

describe('DA-01 DA-06 the dashboard routes (API)', () => {
  it('serves the dashboard before and after the first rollup, and queues a refresh', async () => {
    const before = await admin.call('/dashboard');
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({ asOf: null, gate1: null, arrears: { totalMinor: 0 } });
    const refresh = await admin.call('/dashboard/refresh', { method: 'POST', body: {} });
    expect(refresh.status).toBe(200);
    expect(refresh.json).toEqual({ queued: true });
    // The worker's rollup, through the same module the API loads.
    await api.app.get(ReportingRollupService).run(agencyId);
    const after = await admin.call('/dashboard');
    expect(after.status).toBe(200);
    expect(typeof after.json.asOf).toBe('string');
    expect(after.json.gate1).toMatchObject({ month: expect.any(String) });
    const gate1 = await admin.call('/metrics/gate1');
    expect(gate1.status).toBe(200);
    expect(gate1.json).toMatchObject({ collectionRate: { dueMinor: 0 } });
  });

  it('exports Excel at once and a PDF once rendered', async () => {
    const xlsx = await admin.call('/dashboard/exports', { body: { format: 'xlsx' } });
    expect(xlsx.status).toBe(200);
    expect(xlsx.json).toMatchObject({ format: 'xlsx', status: 'ready', url: expect.any(String) });
    const pdf = await admin.call('/dashboard/exports', { body: { format: 'pdf' } });
    expect(pdf.status).toBe(200);
    expect(pdf.json).toMatchObject({ format: 'pdf', status: 'rendering', url: null });
    const again = await admin.call(`/dashboard/exports/${String(pdf.json.id)}`);
    expect(again.status).toBe(200);
    expect(again.json.status).toBe('rendering');
  });

  it('lists the compliance items, and refuses a caretaker everywhere', async () => {
    const list = await admin.call('/compliance');
    expect(list.status).toBe(200);
    expect(list.json).toEqual([]);
    for (const path of ['/dashboard', '/compliance', '/metrics/gate1'])
      expect((await caretaker.call(path)).status, path).toBe(403);
  });

  it('shows Gate 1 across companies to platform admins only', async () => {
    const all = await platformAdmin.call('/platform/metrics/gate1');
    expect(all.status).toBe(200);
    const companies = all.json.companies as { company: { id: string } }[];
    expect(companies.map((c) => c.company.id)).toContain(agencyId);
    expect((await admin.call('/platform/metrics/gate1')).status).toBe(403);
  });
});
