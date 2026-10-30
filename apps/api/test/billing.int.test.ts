import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { InvoicingService } from '@rent/server/billing';
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
 * The billing API (M4a plan 4.18) over HTTP: the money card, cash with its approval, idempotent
 * money writes (plan 4.15), who may read what (plan 4.17), and the evidence an approver sees.
 */
const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

let api: TestApi;
let agencyId: string;
let admin: Device;
let manager: Device;
let caretaker: Device;
let today: string;
let units: { id: string; code: string }[];
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

/** A presigned upload, then the bytes where the browser would put them. */
async function upload(
  device: Device,
  path: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await device.call(path, {
    body: { contentType: 'application/pdf', sizeBytes: PDF.length, ...body },
  });
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  const fields = response.json.fields as Record<string, string>;
  await api.storage.put({
    bucket: api.config.S3_BUCKET_FILES,
    key: fields.key!,
    body: PDF,
    contentType: 'application/pdf',
  });
  return String(response.json.uploadId);
}

async function paperLease(unitId: string, name: string) {
  const tenant = await manager.call('/tenants', {
    body: { kind: 'individual', displayName: name },
  });
  const start = toIsoDate(addMonths(parseBusinessDate(today), -1));
  const response = await manager.call('/leases/paper', {
    body: {
      unitId,
      tenantId: (tenant.json.tenant as { id: string }).id,
      startDate: start,
      endDate: endAfter(start, 12),
      monthlyRentMinor: 100_000,
      depositMinor: 100_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name }],
      scanUploadId: await upload(manager, '/lease-uploads', {}),
      signedOn: day(-40),
      billingStartDate: start,
    },
  });
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  const leaseId = String(response.json.id);
  await api.app.get(InvoicingService).onLeaseSigned(agencyId, leaseId);
  return leaseId;
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off', OTP_SENDS_PER_PHONE: 50 });
  today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  agencyId = await createCompany(api, 'agency', 'Billing API Agency');
  admin = await signedIn('admin@billing.invalid', 'agency_admin');
  manager = await signedIn('manager@billing.invalid', 'property_manager');
  const owner = await admin.call('/owners', {
    body: { kind: 'individual', displayName: 'Owner A' },
  });
  const property = await manager.call('/properties', {
    body: {
      areaCode: 'ACC',
      propertyPart: 'LEG',
      name: 'Legon',
      propertyType: 'compound_house',
      use: 'residential',
      ownerId: owner.json.id,
      address: { region: 'Greater Accra', town: 'Legon' },
      units: [{ unitType: 'single_room', count: 4 }],
    },
  });
  units = (property.json.blocks as { units: { id: string; code: string }[] }[])[0]!.units;
  const { personId } = await createPerson(api, { name: 'Kojo Caretaker', phone: '+233200000401' });
  const membershipId = await addMembership(api, agencyId, personId, 'caretaker');
  await withCompany(api.database, { companyId: agencyId, actorKind: 'system' }, (tx) =>
    tx
      .update(schema.membership)
      .set({ scope: { properties: [String(property.json.id)] } })
      .where(sql`${schema.membership.id} = ${membershipId}`),
  );
  caretaker = await phoneSignIn('+233200000401');
});

afterAll(async () => {
  await api?.close();
});

describe('M2 S8 idempotent requests over HTTP', () => {
  it('requires the key on money writes, replays the same request, and refuses the key for another', async () => {
    const leaseId = await paperLease(units[0]!.id, 'Idempotent Tenant');
    const body = {
      leaseId,
      method: 'cash',
      amountMinor: 50_000,
      receivedOn: today,
      payerName: 'Idempotent Tenant',
      photoUploadId: await upload(caretaker, '/payment-uploads', { purpose: 'cash_photo' }),
    };
    const without = await caretaker.call('/cash-records', { body });
    expect(without.status).toBe(400);
    expect(without.json).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const key = { 'idempotency-key': '0f8fad5b-d9cb-469f-a165-70867728950e' };
    const first = await caretaker.call('/cash-records', { body, headers: key });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const again = await caretaker.call('/cash-records', { body, headers: key });
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    const other = await caretaker.call('/cash-records', {
      body: { ...body, amountMinor: 1 },
      headers: key,
    });
    expect(other.status).toBe(422);
    expect(other.json).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const records = await caretaker.call(`/cash-records?leaseId=${leaseId}`);
    expect((records.json as unknown as unknown[]).length).toBe(1);
    // The approval carries what the approvals screen shows (amountMinor first among them).
    const approval = (first.json as { approval: { id: string; payload: Record<string, unknown> } })
      .approval;
    expect(approval.payload).toMatchObject({
      amountMinor: 50_000,
      method: 'cash',
      unitCode: units[0]!.code,
    });
    // The approver sees the receipt-book photo before deciding (coordinator, item 1).
    const photoId = (first.json as { cashRecord: { photoDocumentId: string } }).cashRecord
      .photoDocumentId;
    const photo = await admin.call(`/payment-files/${photoId}/download`);
    expect(photo.status).toBe(200);
    expect(String(photo.json.url)).toMatch(/download/);
    // The caretaker may not approve their own record; the admin does, and it posts.
    const decided = await admin.call(`/approvals/${approval.id}/decisions`, {
      body: { decision: 'approve' },
    });
    expect(decided.status, JSON.stringify(decided.json)).toBe(200);
    const card = await manager.call(`/leases/${leaseId}/billing`);
    expect(card.status).toBe(200);
    expect(card.json).toMatchObject({
      leaseId,
      depositHeldMinor: 50_000,
      earnedUnpaidMinor: 200_000,
      currency: 'GHS',
    });
    expect(String(card.json.paymentReference)).toMatch(/^[0-9A-Z]{7}$/);
  });
});

describe('NFR-SEC billing reads by role (plan 4.17)', () => {
  it('refuses caretakers every billing read except their own cash records and cash on hand', async () => {
    const leaseId = await paperLease(units[1]!.id, 'Scope Tenant');
    for (const path of [
      '/invoices',
      `/leases/${leaseId}/billing`,
      '/payments',
      '/receipts',
      '/arrears',
      '/unmatched-receipts',
    ]) {
      const response = await caretaker.call(path);
      expect(response.status, path).toBe(403);
    }
    expect((await caretaker.call('/cash-records')).status).toBe(200);
    expect((await caretaker.call('/collectors/cash')).status).toBe(200);
    const invoices = await manager.call(`/invoices?leaseId=${leaseId}`);
    expect(invoices.status).toBe(200);
    const rows = invoices.json as unknown as { kind: string; status: string; number: string }[];
    expect(rows.map((r) => r.kind).sort()).toEqual(['cycle', 'cycle', 'deposit']);
    expect(rows.every((r) => /^INV-\d{6}$/.test(r.number))).toBe(true);
    const detail = await manager.call(`/invoices/${(rows[0] as unknown as { id: string }).id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ lines: expect.any(Array), allocations: expect.any(Array) });
    const arrears = await manager.call(`/arrears?by=property&asOf=${today}`);
    expect(arrears.status).toBe(200);
    // A reversal is asked for with billing.manage, and needs the key too.
    const reversal = await caretaker.call(
      '/payments/00000000-0000-7000-8000-000000000000/reversal-requests',
      {
        body: { reason: 'wrong_entry', note: 'Not ours at all', moneyNowIn: 'collector' },
        headers: { 'idempotency-key': 'caretaker-reversal-1' },
      },
    );
    expect(reversal.status).toBe(403);
  });
});
