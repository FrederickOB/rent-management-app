import { schema, sql, withCompany } from '@rent/db';
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
  Device,
  enrolStaff,
  startApi,
  type TestApi,
} from './support';

const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

let api: TestApi;
let agencyId: string;
let landlordId: string;
let manager: Device;
let admin: Device;
let landlord: Device;
let caretaker: Device;
let today: string;
const day = (n: number) => toIsoDate(addDays(parseBusinessDate(today), n));
const endAfter = (from: string, months: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), months), -1));
let elgUnits: { id: string; code: string }[];
let temUnit: string;

async function signedIn(
  companyId: string,
  email: string,
  role: 'agency_admin' | 'property_manager' | 'owner',
) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

/** Signs a person in by phone code, as the Expo app does. */
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

/** Uploads a scan the way the browser does: a presigned upload, then the bytes. */
async function scan(device: Device): Promise<string> {
  const upload = await device.call('/lease-uploads', {
    body: { contentType: 'application/pdf', sizeBytes: PDF.length },
  });
  expect(upload.status).toBe(200);
  const fields = upload.json.fields as Record<string, string>;
  await api.storage.put({
    bucket: api.config.S3_BUCKET_FILES,
    key: fields.key!,
    body: PDF,
    contentType: 'application/pdf',
  });
  return String(upload.json.uploadId);
}

async function paperLease(
  device: Device,
  unitId: string,
  tenantId: string,
  over: Record<string, unknown> = {},
) {
  const response = await device.call('/leases/paper', {
    body: {
      unitId,
      tenantId,
      startDate: day(-15),
      endDate: endAfter(day(-15), 12),
      monthlyRentMinor: 180_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Tenant', paperSignedOn: day(-16) }],
      scanUploadId: await scan(device),
      signedOn: day(-16),
      ...over,
    },
  });
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json as { id: string; status: string; signing: { signedOnPaper: boolean } };
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off', OTP_SENDS_PER_PHONE: 50 });
  today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  agencyId = await createCompany(api, 'agency', 'Tenancy API Agency');
  landlordId = await createCompany(api, 'landlord', 'Tenancy API Landlord');
  admin = await signedIn(agencyId, 'admin@tenancy.invalid', 'agency_admin');
  manager = await signedIn(agencyId, 'manager@tenancy.invalid', 'property_manager');
  landlord = await signedIn(landlordId, 'landlord@tenancy.invalid', 'owner');
  const owner = await admin.call('/owners', {
    body: { kind: 'individual', displayName: 'Owner A' },
  });
  const elg = await manager.call('/properties', {
    body: {
      areaCode: 'ACC',
      propertyPart: 'ELG',
      name: 'East Legon flats',
      propertyType: 'apartment_block',
      use: 'residential',
      ownerId: owner.json.id,
      address: { region: 'Greater Accra', town: 'East Legon' },
      units: [{ unitType: 'apartment', count: 3, bedrooms: 2 }],
    },
  });
  elgUnits = (elg.json.blocks as { units: { id: string; code: string }[] }[])[0]!.units;
  const tem = await landlord.call('/properties', {
    body: {
      areaCode: 'TEM',
      propertyPart: 'EST',
      name: 'Tema house',
      propertyType: 'house',
      use: 'residential',
      address: { region: 'Greater Accra', town: 'Tema' },
      units: [{ unitType: 'apartment', count: 1, bedrooms: 3 }],
    },
  });
  temUnit = (tem.json.blocks as { units: { id: string }[] }[])[0]!.units[0]!.id;
  // A caretaker for East Legon, signing in by phone (AD-06).
  const { personId } = await createPerson(api, { name: 'Caretaker', phone: '+233200000301' });
  const membershipId = await addMembership(api, agencyId, personId, 'caretaker');
  await withCompany(api.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
    tx
      .update(schema.membership)
      .set({ scope: { properties: [String(elg.json.id)] } })
      .where(sql`${schema.membership.id} = ${membershipId}`),
  );
  caretaker = await phoneSignIn('+233200000301');
});

afterAll(async () => {
  await api?.close();
});

describe('TL-01 tenant profiles and one person, two landlords over HTTP', () => {
  it('shows the tenant both tenancies in the app, and neither landlord the other’s tenant or lease', async () => {
    const atAgency = await manager.call('/tenants', {
      body: {
        kind: 'individual',
        displayName: 'Ama Two-Landlords',
        phone: '020 000 0311',
        consent: { sms: true },
      },
    });
    expect(atAgency.status).toBe(200);
    const atLandlord = await landlord.call('/tenants', {
      body: { kind: 'individual', displayName: 'A. Two-Landlords', phone: '+233200000311' },
    });
    // The second company gets the same shape of answer, with no warning about the first.
    expect(atLandlord.json.duplicates).toEqual([]);
    const agencyTenant = (atAgency.json.tenant as { id: string }).id;
    const landlordTenant = (atLandlord.json.tenant as { id: string }).id;
    expect(JSON.stringify(atAgency.json)).not.toMatch(/personId|person_id/);
    const agencyLease = await paperLease(manager, elgUnits[0]!.id, agencyTenant);
    const landlordLease = await paperLease(landlord, temUnit, landlordTenant);
    expect(agencyLease).toMatchObject({ status: 'active', signing: { signedOnPaper: true } });

    const tenant = await phoneSignIn('+233200000311');
    const mine = await tenant.call('/me/tenancies');
    expect(mine.status).toBe(200);
    const groups = mine.json as unknown as {
      landlord: { name: string };
      tenancies: { leaseId: string; unitCode: string; documentId: string }[];
    }[];
    expect(groups.map((g) => g.landlord.name).sort()).toEqual([
      'Tenancy API Agency',
      'Tenancy API Landlord',
    ]);
    const card = groups.flatMap((g) => g.tenancies).find((t) => t.leaseId === landlordLease.id)!;
    expect(card.unitCode).toBe('TEM-EST-B1-01');
    const detail = await tenant.call(`/me/tenancies/${landlordLease.id}`);
    expect(detail.json).toMatchObject({
      leaseId: landlordLease.id,
      monthlyRentMinor: 180_000,
      noticeDays: 30,
    });
    const download = await tenant.call(`/me/documents/${card.documentId}/download`);
    expect(download.status).toBe(200);
    expect(String(download.json.url)).toMatch(/^memory:\/\/download\//);

    // Each company sees only its own record, over HTTP.
    expect((await manager.call(`/tenants/${landlordTenant}`)).status).toBe(404);
    expect((await landlord.call(`/tenants/${agencyTenant}`)).status).toBe(404);
    expect((await manager.call(`/leases/${landlordLease.id}`)).status).toBe(404);
    const listed = (await manager.call('/tenants')).json as unknown as { id: string }[];
    expect(listed.map((t) => t.id)).not.toContain(landlordTenant);
    // A tenant is not staff, and staff are not tenants.
    expect((await tenant.call('/tenants')).status).toBe(403);
    expect((await manager.call('/me/tenancies')).status).toBe(403);
    // Another tenant cannot fetch this tenant's document.
    const other = await createPerson(api, { name: 'Other tenant', phone: '+233200000312' });
    expect(other.personId).toBeTruthy();
    const stranger = await phoneSignIn('+233200000312');
    expect((await stranger.call(`/me/documents/${card.documentId}/download`)).status).toBe(404);
    expect((await stranger.call(`/me/tenancies/${landlordLease.id}`)).status).toBe(404);
  });
});

describe('TL-02 ID numbers over HTTP', () => {
  it('masks the number, reveals it only with a reason, and gives a caretaker only name, phone and unit', async () => {
    const created = await manager.call('/tenants', {
      body: {
        kind: 'individual',
        displayName: 'Kofi Card',
        phone: '+233200000321',
        idType: 'ghana_card',
        idNumber: 'GHA-246813579-1',
      },
    });
    const tenant = created.json.tenant as { id: string; identity: { masked: string } };
    expect(tenant.identity.masked).toBe('GHA-*******79-1');
    expect(JSON.stringify(created.json)).not.toContain('246813579');
    await paperLease(manager, elgUnits[1]!.id, tenant.id);
    const shortReason = await manager.call(`/tenants/${tenant.id}/id-number/reveal`, {
      body: { reason: 'why' },
    });
    expect(shortReason.status).toBe(400);
    const revealed = await manager.call(`/tenants/${tenant.id}/id-number/reveal`, {
      body: { reason: 'Rent Control registration form' },
    });
    expect(revealed.json).toEqual({
      idType: 'ghana_card',
      idNumber: 'GHA-246813579-1',
      country: 'GH',
    });
    expect(
      (
        await caretaker.call(`/tenants/${tenant.id}/id-number/reveal`, {
          body: { reason: 'Just curious about it' },
        })
      ).status,
    ).toBe(403);
    const seen = await caretaker.call(`/tenants/${tenant.id}`);
    expect(seen.json).toEqual({
      access: 'limited',
      id: tenant.id,
      kind: 'individual',
      displayName: 'Kofi Card',
      phone: '+233200000321',
      units: [elgUnits[1]!.code],
    });
    const leases = await caretaker.call('/leases');
    const rows = leases.json as unknown as { access: string; unit: { code: string } }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.access === 'limited')).toBe(true);
    expect(JSON.stringify(leases.json)).not.toMatch(/monthlyRentMinor|Kofi/);
  });
});

describe('PB-09 unit cannot be set vacant with an active lease over HTTP', () => {
  it('refuses availability other than available or under repair, and archiving, while a lease holds the unit', async () => {
    const unitId = elgUnits[0]!.id; // the agency's two-landlord tenancy
    const refused = await manager.call(`/units/${unitId}/availability`, {
      body: { availability: 'not_lettable', reason: 'Use it as a store' },
    });
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe('UNIT.OCCUPIED');
    expect((await manager.call(`/units/${unitId}/archive`, { method: 'POST' })).status).toBe(409);
    const unit = await manager.call(`/units/${unitId}`);
    expect(unit.json).toMatchObject({ status: 'occupied', occupancy: 'occupied' });
    expect(
      (unit.json.history as { kind: string; source: string }[]).some(
        (h) => h.kind === 'occupancy' && h.source === 'lease',
      ),
    ).toBe(true);
  });
});

describe('TL-06 leases over HTTP', () => {
  it('drafts, previews and edits a lease, and shows the schedule of a signed one', async () => {
    const tenant = (
      await manager.call('/tenants', {
        body: {
          kind: 'individual',
          displayName: 'Draft Tenant',
          phone: '+233200000331',
          email: 'draft@example.org',
        },
      })
    ).json.tenant as { id: string };
    const draft = await manager.call('/leases', {
      body: {
        unitId: elgUnits[2]!.id,
        tenantId: tenant.id,
        startDate: day(40),
        endDate: endAfter(day(40), 12),
        monthlyRentMinor: 200_000,
        cycle: 'monthly',
        noticeDays: 30,
      },
    });
    expect(draft.status).toBe(200);
    expect(draft.json).toMatchObject({
      status: 'draft',
      servicePhones: ['+233200000331'],
      serviceEmails: ['draft@example.org'],
      witnessRequired: true,
      counselReviewWarning: true,
      advanceFlag: null,
    });
    const id = String(draft.json.id);
    const preview = await manager.call(`/leases/${id}/preview`);
    expect(preview.status).toBe(200);
    expect(String(preview.json.html)).toContain('GH₵2,000.00');
    const edited = await manager.call(`/leases/${id}`, {
      method: 'PATCH',
      body: { monthlyRentMinor: 210_000 },
    });
    expect(edited.json).toMatchObject({ terms: { monthlyRentMinor: 210_000 } });
    const invalid = await manager.call(`/leases/${id}`, {
      method: 'PATCH',
      body: { endDate: day(10) },
    });
    expect(invalid.status).toBe(422);
    const cancelled = await manager.call(`/leases/${id}/cancel`, {
      body: { reason: 'Tenant changed plans' },
    });
    expect(cancelled.json).toMatchObject({ status: 'cancelled' });

    const signed = await manager.call('/leases');
    const active = (signed.json as unknown as { id: string; status: string }[]).find(
      (l) => l.status === 'active',
    )!;
    const schedule = await manager.call(`/leases/${active.id}/schedule`);
    expect((schedule.json as unknown as unknown[]).length).toBeGreaterThanOrEqual(12);
    expect((await caretaker.call(`/leases/${active.id}/schedule`)).status).toBe(403);
    const expiring = await manager.call('/leases/expiring?days=366');
    expect((expiring.json as unknown as { id: string }[]).map((l) => l.id)).toContain(active.id);
    const templates = await manager.call('/lease-templates');
    expect((templates.json as unknown as unknown[]).length).toBe(3);
  });

  it('asks a second person to approve cancelling a signed lease', async () => {
    const tenant = (
      await manager.call('/tenants', { body: { kind: 'individual', displayName: 'Future Tenant' } })
    ).json.tenant as { id: string };
    const lease = await paperLease(manager, elgUnits[2]!.id, tenant.id, {
      startDate: day(60),
      endDate: endAfter(day(60), 12),
      signedOn: day(0),
      parties: [{ role: 'tenant', name: 'Future Tenant' }],
    });
    expect(lease.status).toBe('signed');
    const asked = await manager.call(`/leases/${lease.id}/cancel-signed`, {
      body: { reason: 'The tenant withdrew before moving in' },
    });
    expect(asked.status).toBe(200);
    expect(asked.json).toMatchObject({
      actionType: 'lease.cancel_signed',
      status: 'pending',
      mode: 'two_person',
    });
    const self = await manager.call(`/approvals/${String(asked.json.id)}/decisions`, {
      body: { decision: 'approve' },
    });
    expect(self.status).toBe(403);
    const approved = await admin.call(`/approvals/${String(asked.json.id)}/decisions`, {
      body: { decision: 'approve' },
    });
    expect(approved.json).toMatchObject({ status: 'approved' });
    expect((await manager.call(`/leases/${lease.id}`)).json).toMatchObject({ status: 'cancelled' });
  });
});

describe('Owner tax fields over HTTP (plan 4.13)', () => {
  it('records letting business, VAT registration and an encrypted TIN, revealed only with a reason', async () => {
    const created = await admin.call('/owners', {
      body: {
        kind: 'company',
        displayName: 'Tax Owner Ltd',
        lettingBusiness: true,
        vatRegistered: true,
        tin: 'C0011223344',
      },
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({
      lettingBusiness: true,
      vatRegistered: true,
      tinMasked: '*******3344',
    });
    expect(JSON.stringify(created.json)).not.toContain('C0011223344');
    const id = String(created.json.id);
    expect(
      (
        await manager.call(`/owners/${id}/tin/reveal`, {
          body: { reason: 'Withholding tax return' },
        })
      ).status,
    ).toBe(403);
    const revealed = await admin.call(`/owners/${id}/tin/reveal`, {
      body: { reason: 'Withholding tax return' },
    });
    expect(revealed.json).toEqual({ tin: 'C0011223344' });
    const cleared = await admin.call(`/owners/${id}`, {
      method: 'PATCH',
      body: { tin: null, vatRegistered: false },
    });
    expect(cleared.json).toMatchObject({ tinMasked: null, vatRegistered: false });
  });
});

describe('ADR-014 the M3 contract is served and described', () => {
  it('lists the tenancy routes in the OpenAPI document', async () => {
    const doc = (await new Device(api.baseUrl).call('/openapi.json')).json as {
      paths: Record<string, unknown>;
    };
    for (const path of [
      '/tenants',
      '/tenants/{tenantId}/id-number/reveal',
      '/leases/paper',
      '/leases/{leaseId}/cancel-signed',
      '/me/tenancies',
      '/me/documents/{documentId}/download',
      '/lease-templates',
    ])
      expect(Object.keys(doc.paths), path).toContain(path);
  });
});
