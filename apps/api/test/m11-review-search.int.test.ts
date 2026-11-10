import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  type Device,
  enrolStaff,
  startApi,
  type TestApi,
} from './support';

/**
 * M11 review: names stay out of URLs. Tenants are searched only by POST (GET /tenants takes the
 * filters, and no longer a search), and leases gain the same POST search as their list.
 */
const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

let api: TestApi;
let agencyId: string;
let manager: Device;
let tenantId: string;
let leaseId: string;
let today: string;
const day = (n: number) => toIsoDate(addDays(parseBusinessDate(today), n));

async function signedIn(email: string, role: 'agency_admin' | 'property_manager') {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, agencyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  agencyId = await createCompany(api, 'agency', 'Search Review Agency');
  const admin = await signedIn('admin@search-review.invalid', 'agency_admin');
  manager = await signedIn('manager@search-review.invalid', 'property_manager');
  const owner = await admin.call('/owners', { body: { kind: 'individual', displayName: 'Owner' } });
  const property = await manager.call('/properties', {
    body: {
      areaCode: 'ACC',
      propertyPart: 'SRV',
      name: 'Search flats',
      propertyType: 'apartment_block',
      use: 'residential',
      ownerId: owner.json.id,
      address: { region: 'Greater Accra', town: 'Osu' },
      units: [{ unitType: 'apartment', count: 1, bedrooms: 2 }],
    },
  });
  const unitId = (property.json.blocks as { units: { id: string }[] }[])[0]!.units[0]!.id;
  for (const name of ['Findable Ama', 'Other Kojo'])
    await manager.call('/tenants', { body: { kind: 'individual', displayName: name } });
  const tenants = (await manager.call('/tenants')).json as unknown as {
    id: string;
    displayName: string;
  }[];
  tenantId = tenants.find((t) => t.displayName === 'Findable Ama')!.id;
  const upload = await manager.call('/lease-uploads', {
    body: { contentType: 'application/pdf', sizeBytes: PDF.length },
  });
  const fields = upload.json.fields as Record<string, string>;
  await api.storage.put({
    bucket: api.config.S3_BUCKET_FILES,
    key: fields.key!,
    body: PDF,
    contentType: 'application/pdf',
  });
  const lease = await manager.call('/leases/paper', {
    body: {
      unitId,
      tenantId,
      startDate: day(-15),
      endDate: toIsoDate(addDays(addMonths(parseBusinessDate(day(-15)), 12), -1)),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Findable Ama', paperSignedOn: day(-16) }],
      scanUploadId: String(upload.json.uploadId),
      signedOn: day(-16),
    },
  });
  expect(lease.status, JSON.stringify(lease.json)).toBe(200);
  leaseId = String(lease.json.id);
});

afterAll(async () => {
  await api?.close();
});

describe('TL-01 TL-06 NFR-SEC names stay out of URLs (M11 review)', () => {
  it('GET /tenants no longer searches: a name in its query string filters nothing', async () => {
    const all = (await manager.call('/tenants')).json as unknown as { id: string }[];
    const queried = await manager.call('/tenants?search=Findable');
    expect(queried.status).toBe(200);
    expect((queried.json as unknown as { id: string }[]).map((t) => t.id).sort()).toEqual(
      all.map((t) => t.id).sort(),
    );
    expect(all.length).toBeGreaterThanOrEqual(2);
    // The POST search finds by name.
    const found = await manager.call('/tenants/search', { body: { search: 'Findable' } });
    expect((found.json as unknown as { id: string }[]).map((t) => t.id)).toEqual([tenantId]);
  });

  it('searches leases by POST with the list’s filters and answer', async () => {
    const byName = await manager.call('/leases/search', { body: { search: 'Findable' } });
    expect(byName.status, JSON.stringify(byName.json)).toBe(200);
    const listed = await manager.call(`/leases?tenantId=${tenantId}`);
    expect(byName.json).toEqual(listed.json);
    expect((byName.json as unknown as { id: string }[]).map((l) => l.id)).toEqual([leaseId]);
    const none = await manager.call('/leases/search', { body: { search: 'Nobody Here' } });
    expect(none.json).toEqual([]);
    const filtered = await manager.call('/leases/search', { body: { status: 'cancelled' } });
    expect(filtered.json).toEqual([]);
  });
});
