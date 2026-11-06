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
  enrolStaff,
  startApi,
  type Device,
  type TestApi,
} from './support';

/**
 * The M7 review over HTTP (docs/plans/M7.md section 9.3): append-only creates require an
 * Idempotency-Key (C5); Rent Officer assessments are corrected and voided by new records, with a
 * future date refused (C4, S10); a second live correction is a named 409 (S6); and tasks and
 * notices carry the new flags (C1, C2).
 */
const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

let api: TestApi;
let manager: Device;
let today: string;
let leaseId: string;
let unitId: string;
const day = (n: number) => toIsoDate(addDays(parseBusinessDate(today), n));
const key = (k: string) => ({ 'idempotency-key': `notices-review-${k}` });

async function signedIn(
  companyId: string,
  email: string,
  role: 'agency_admin' | 'property_manager',
) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  const agencyId = await createCompany(api, 'agency', 'Notices Review Agency');
  const admin = await signedIn(agencyId, 'admin@notices-review.invalid', 'agency_admin');
  manager = await signedIn(agencyId, 'manager@notices-review.invalid', 'property_manager');
  const owner = await admin.call('/owners', { body: { kind: 'individual', displayName: 'Owner' } });
  const created = await manager.call('/properties', {
    body: {
      areaCode: 'ACC',
      propertyPart: 'NRV',
      name: 'Review flats',
      propertyType: 'apartment_block',
      use: 'residential',
      ownerId: owner.json.id,
      address: { region: 'Greater Accra', town: 'Legon' },
      units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
    },
  });
  unitId = (created.json.blocks as { units: { id: string }[] }[])[0]!.units[0]!.id;
  const tenant = await manager.call('/tenants', {
    body: {
      kind: 'individual',
      displayName: 'Review Tenant',
      phone: '+233200000421',
      consent: { sms: true },
    },
  });
  const upload = await manager.call('/lease-uploads', {
    body: { contentType: 'application/pdf', sizeBytes: PDF.length },
  });
  await api.storage.put({
    bucket: api.config.S3_BUCKET_FILES,
    key: (upload.json.fields as Record<string, string>).key!,
    body: PDF,
    contentType: 'application/pdf',
  });
  const start = day(-60);
  const lease = await manager.call('/leases/paper', {
    body: {
      unitId,
      tenantId: (tenant.json.tenant as { id: string }).id,
      startDate: start,
      endDate: toIsoDate(addDays(addMonths(parseBusinessDate(start), 12), -1)),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Review Tenant', paperSignedOn: start }],
      scanUploadId: String(upload.json.uploadId),
      signedOn: start,
    },
  });
  expect(lease.status, JSON.stringify(lease.json)).toBe(200);
  leaseId = String(lease.json.id);
});

afterAll(async () => {
  await api?.close();
});

describe('M7 review C5: append-only creates require an Idempotency-Key', () => {
  it('refuses service records and assessments without one, and replays with one', async () => {
    const draft = await manager.call('/notices', {
      body: {
        type: 'breach',
        subtype: 'noise',
        leaseId,
        fields: { particulars: 'Loud music', remedyBy: day(10) },
      },
    });
    const id = String(draft.json.id);
    expect((await manager.call(`/notices/${id}/issue`, { body: {} })).status).toBe(200);
    const service = {
      method: 'handed_to_tenant',
      servedAt: new Date().toISOString(),
      servedByName: 'Kojo Caretaker',
    };
    const bare = await manager.call(`/notices/${id}/service-records`, { body: service });
    expect(bare.status).toBe(400);
    expect(bare.json).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const first = await manager.call(`/notices/${id}/service-records`, {
      body: service,
      headers: key('service'),
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const replay = await manager.call(`/notices/${id}/service-records`, {
      body: service,
      headers: key('service'),
    });
    expect((replay.json.serviceRecords as unknown[]).length).toBe(1);

    const correction = await manager.call(`/notices/${id}/correct`, {
      body: {},
      headers: key('correct'),
    });
    expect(correction.status, JSON.stringify(correction.json)).toBe(200);
    expect(correction.json).toMatchObject({
      corrects: { id },
      lastApproval: null,
      returnedReason: null,
    });
    const second = await manager.call(`/notices/${id}/correct`, {
      body: {},
      headers: key('correct-2'),
    });
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({ code: 'NOTICE_CORRECTION_OPEN' });

    const issued = await manager.call(`/notices/${id}`);
    expect(issued.json.actions).toMatchObject({ handover: false });
    const tasks = (await manager.call('/tasks')).json as unknown as { mayCancel: boolean }[];
    expect(tasks.every((t) => typeof t.mayCancel === 'boolean')).toBe(true);
  });
});

describe('M7 review C4 and S10: assessments over HTTP', () => {
  it('records, corrects and voids an assessment, and refuses a future date', async () => {
    const path = `/units/${unitId}/rent-assessments`;
    const future = await manager.call(path, {
      body: { assessedOn: day(1), reference: 'RO/FUTURE' },
      headers: key('future'),
    });
    expect(future.status).toBe(400);
    expect(future.json).toMatchObject({ code: 'ASSESSED_ON_FUTURE' });
    expect(
      (await manager.call(path, { body: { assessedOn: day(-30), reference: 'RO/1' } })).status,
    ).toBe(400);
    const first = await manager.call(path, {
      body: { assessedOn: day(-30), reference: 'RO/1' },
      headers: key('record'),
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const corrected = await manager.call(`${path}/${String(first.json.id)}/correct`, {
      body: { assessedOn: day(-40), reference: 'RO/1A', reason: 'Wrong date' },
      headers: key('correct-assessment'),
    });
    expect(corrected.json).toMatchObject({ replacesId: first.json.id, status: 'active' });
    const voided = await manager.call(`${path}/${String(corrected.json.id)}/void`, {
      body: { reason: 'Recorded on the wrong unit' },
      headers: key('void'),
    });
    expect(voided.json).toMatchObject({ status: 'voided' });
    const again = await manager.call(`${path}/${String(corrected.json.id)}/void`, {
      body: { reason: 'Again' },
      headers: key('void-2'),
    });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: 'ASSESSMENT_CHANGED' });
    const list = await manager.call(path);
    expect(list.json).toMatchObject({ bar: null, ruleMissing: false });
    expect((list.json.assessments as { status: string }[]).map((a) => a.status).sort()).toEqual([
      'corrected',
      'voided',
    ]);
  });
});

describe('M7 review S6: starting a correction, with or without a key', () => {
  it('replays a keyed start, refuses the key on another notice with 422, and refuses a second live correction with 409', async () => {
    const issue = async () => {
      const draft = await manager.call('/notices', {
        body: {
          type: 'breach',
          subtype: 'noise',
          leaseId,
          fields: { particulars: 'Loud music', remedyBy: day(10) },
        },
      });
      const id = String(draft.json.id);
      expect((await manager.call(`/notices/${id}/issue`, { body: {} })).status).toBe(200);
      return id;
    };
    const first = await issue();
    const unkeyed = await manager.call(`/notices/${first}/correct`, { body: {} });
    expect(unkeyed.status, JSON.stringify(unkeyed.json)).toBe(200);
    const again = await manager.call(`/notices/${first}/correct`, { body: {} });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: 'NOTICE_CORRECTION_OPEN' });

    const second = await issue();
    const keyed = await manager.call(`/notices/${second}/correct`, {
      body: {},
      headers: key('optional-correct'),
    });
    expect(keyed.status, JSON.stringify(keyed.json)).toBe(200);
    const replay = await manager.call(`/notices/${second}/correct`, {
      body: {},
      headers: key('optional-correct'),
    });
    expect(replay.status).toBe(200);
    expect(replay.json.id).toBe(keyed.json.id);
    const reused = await manager.call(`/notices/${first}/correct`, {
      body: {},
      headers: key('optional-correct'),
    });
    expect(reused.status).toBe(422);
    expect(reused.json).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
