import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { EICAR_TEST_FILE } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  createCompany,
  createPerson,
  Device,
  enrolStaff,
  startApi,
  type TestApi,
} from './support';

/**
 * M11 decision 6 over HTTP: tenant search moves to POST, so a searched phone number or name never
 * sits in a URL; and an upload's scan status, its refusals while pending (409) and once
 * quarantined (410) on the staff and tenant routes, with their codes as clients see them.
 */
const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);
/** The EICAR test string in a PDF's stream: the fake scanner and ClamAV both report it. */
const INFECTED_PDF = Buffer.from(
  `%PDF-1.4\n1 0 obj<</Length ${EICAR_TEST_FILE.length}>>stream\n${EICAR_TEST_FILE}\nendstream\nendobj\n` +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

let api: TestApi;
let agencyId: string;
let manager: Device;
let admin: Device;
let units: { id: string }[];
let today: string;
const day = (n: number) => toIsoDate(addDays(parseBusinessDate(today), n));
const endAfter = (from: string, months: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), months), -1));

async function signedIn(email: string, role: 'agency_admin' | 'property_manager') {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, agencyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

async function phoneSignIn(phone: string): Promise<Device> {
  const device = new Device(api.baseUrl, 'Expo/Android');
  await device.call('/api/auth/phone-number/send-otp', { body: { phoneNumber: phone } });
  const code = /\b(\d{6})\b/.exec(api.sms.lastTo(phone)!.body)![1]!;
  const verified = await device.call('/api/auth/phone-number/verify', {
    body: { phoneNumber: phone, code },
  });
  if (verified.status !== 200) throw new Error(`phone sign-in failed: ${verified.status}`);
  return device;
}

/** A paper lease with its scan, uploaded by the manager as the browser does. */
async function paperLease(unitId: string, tenantId: string, scan: Buffer) {
  const upload = await manager.call('/lease-uploads', {
    body: { contentType: 'application/pdf', sizeBytes: scan.length },
  });
  const fields = upload.json.fields as Record<string, string>;
  await api.storage.put({
    bucket: api.config.S3_BUCKET_FILES,
    key: fields.key!,
    body: scan,
    contentType: 'application/pdf',
  });
  const lease = await manager.call('/leases/paper', {
    body: {
      unitId,
      tenantId,
      startDate: day(-15),
      endDate: endAfter(day(-15), 12),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Tenant', paperSignedOn: day(-16) }],
      scanUploadId: String(upload.json.uploadId),
      signedOn: day(-16),
    },
  });
  expect(lease.status, JSON.stringify(lease.json)).toBe(200);
  return String(lease.json.id);
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off', OTP_SENDS_PER_PHONE: 50 });
  today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  agencyId = await createCompany(api, 'agency', 'Uploads API Agency');
  admin = await signedIn('admin@uploads.invalid', 'agency_admin');
  manager = await signedIn('manager@uploads.invalid', 'property_manager');
  const owner = await admin.call('/owners', {
    body: { kind: 'individual', displayName: 'Uploads owner' },
  });
  const property = await manager.call('/properties', {
    body: {
      areaCode: 'ACC',
      propertyPart: 'UPL',
      name: 'Uploads flats',
      propertyType: 'apartment_block',
      use: 'residential',
      ownerId: owner.json.id,
      address: { region: 'Greater Accra', town: 'Osu' },
      units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
    },
  });
  units = (property.json.blocks as { units: { id: string }[] }[])[0]!.units;
});

afterAll(async () => {
  await api?.close();
});

describe('TL-01 NFR-SEC tenant search by POST keeps the search out of the URL (M11 decision 6)', () => {
  it('finds tenants by phone or name with the list’s filters, for staff only', async () => {
    const created = await manager.call('/tenants', {
      body: { kind: 'individual', displayName: 'Searchable Abena', phone: '020 007 1001' },
    });
    expect(created.status).toBe(200);
    const id = (created.json.tenant as { id: string }).id;
    const byPhone = await manager.call('/tenants/search', { body: { search: '200071001' } });
    expect(byPhone.status).toBe(200);
    expect((byPhone.json as unknown as { id: string }[]).map((t) => t.id)).toContain(id);
    const byName = await manager.call('/tenants/search', {
      body: { search: 'Searchable', kind: 'individual', includeArchived: false },
    });
    expect((byName.json as unknown as { id: string }[]).map((t) => t.id)).toEqual([id]);
    const none = await manager.call('/tenants/search', { body: { search: 'Nobody Here' } });
    expect(none.json).toEqual([]);
    // The list keeps working for filters; a tenant session is refused, as on the list.
    expect((await manager.call('/tenants')).status).toBe(200);
    const tenant = await phoneSignIn('+233200071001');
    expect((await tenant.call('/tenants/search', { body: { search: 'Abena' } })).status).toBe(403);
  });
});

describe('NFR-SEC an upload’s scan status and refusals over HTTP (M11 decision 6)', () => {
  it('reports a clean upload to its uploader, staff and its tenant, and refuses a quarantined one with 410', async () => {
    const tenantA = await manager.call('/tenants', {
      body: { kind: 'individual', displayName: 'Scan Kofi', phone: '020 007 1002' },
    });
    const tenantB = await manager.call('/tenants', {
      body: { kind: 'individual', displayName: 'Scan Efua', phone: '020 007 1003' },
    });
    const cleanLease = await paperLease(
      units[0]!.id,
      (tenantA.json.tenant as { id: string }).id,
      PDF,
    );
    const badLease = await paperLease(
      units[1]!.id,
      (tenantB.json.tenant as { id: string }).id,
      INFECTED_PDF,
    );
    const tenant = await phoneSignIn('+233200071002');
    const cards = (await tenant.call('/me/tenancies')).json as unknown as {
      tenancies: { documentId: string }[];
    }[];
    const cleanDoc = cards.flatMap((g) => g.tenancies)[0]!.documentId;
    const clean = await manager.call(`/documents/${cleanDoc}/scan`);
    expect(clean.status).toBe(200);
    expect(clean.json).toMatchObject({ documentId: cleanDoc, status: 'clean' });
    expect(String(clean.json.scannedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await admin.call(`/documents/${cleanDoc}/scan`)).json).toMatchObject({
      status: 'clean',
    });
    expect((await tenant.call(`/documents/${cleanDoc}/scan`)).json).toMatchObject({
      status: 'clean',
    });
    const served = await admin.call(`/leases/${cleanLease}/files/signed/download`);
    expect(served.status).toBe(200);
    expect(String(served.json.url)).toMatch(/^memory:\/\/download\//);

    // The infected scan: quarantined at once, refused with 410 and its code, its uploader included.
    const refused = await manager.call(`/leases/${badLease}/files/signed/download`);
    expect(refused.status).toBe(410);
    expect(refused.json).toMatchObject({ code: 'DOCUMENT_QUARANTINED' });
    const viaApp = await phoneSignIn('+233200071003');
    const theirCards = (await viaApp.call('/me/tenancies')).json as unknown as {
      tenancies: { documentId: string }[];
    }[];
    const theirDoc = theirCards.flatMap((g) => g.tenancies)[0]!.documentId;
    const appRefusal = await viaApp.call(`/me/documents/${theirDoc}/download`);
    expect(appRefusal.status).toBe(410);
    expect(appRefusal.json).toMatchObject({ code: 'DOCUMENT_QUARANTINED' });
    expect((await manager.call(`/documents/${theirDoc}/scan`)).json).toMatchObject({
      status: 'infected',
    });
    // Another tenant of the landlord sees nothing of it.
    expect((await tenant.call(`/documents/${theirDoc}/scan`)).status).toBe(404);
  });
});
