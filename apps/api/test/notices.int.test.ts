import { schema, sql, withCompany } from '@rent/db';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { runSqlWithoutTriggers } from '@rent/db/testing';
import { CURRENT_QUIT_ACK } from '@rent/domain/notices';
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
 * M7 over HTTP (plan 4.10 and 4.11): the routes the web app, the links pages and the tenant app
 * rely on, with their named refusals (OQ-16, frozen notices, the plan), idempotent drafts, and
 * scope inside one company and across two. The services' own suite covers the behaviour.
 */
const PASSWORD = 'correct horse battery staple';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);
const TENANT_PHONE = '+233200000411';

let api: TestApi;
let admin: Device;
let manager: Device;
let caretaker: Device;
let otherCaretaker: Device;
let landlord: Device;
let starter: Device;
let today: string;
let leaseId: string;
let unitId: string;
const day = (n: number) => toIsoDate(addDays(parseBusinessDate(today), n));
const endAfter = (from: string, months: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), months), -1));

async function signedIn(
  companyId: string,
  email: string,
  role: 'agency_admin' | 'property_manager' | 'owner' | 'platform_admin',
) {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, companyId, personId, role);
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

async function caretakerFor(companyId: string, propertyId: string, phone: string) {
  const { personId } = await createPerson(api, { name: `Caretaker ${phone}`, phone });
  const membershipId = await addMembership(api, companyId, personId, 'caretaker');
  await withCompany(api.database, { companyId, actorKind: 'system' }, (tx) =>
    tx
      .update(schema.membership)
      .set({ scope: { properties: [propertyId] } })
      .where(sql`${schema.membership.id} = ${membershipId}`),
  );
  return phoneSignIn(phone);
}

async function property(part: string, ownerId: string) {
  const created = await manager.call('/properties', {
    body: {
      areaCode: 'ACC',
      propertyPart: part,
      name: `Flats ${part}`,
      propertyType: 'apartment_block',
      use: 'residential',
      ownerId,
      address: { region: 'Greater Accra', town: 'Legon' },
      units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
    },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  return {
    id: String(created.json.id),
    units: (created.json.blocks as { units: { id: string }[] }[])[0]!.units.map((u) => u.id),
  };
}

/**
 * A rent demand as the composer suggests it from the ledger. M7 review M2 checks a demand against
 * the ledger (fixture change approved by the founder, 2026-11-04): the lease is billed from its
 * start, so its first invoices are overdue, and the demand names them and what they still owe.
 */
let demandFields: Record<string, unknown> = {};
const demand = (over: Record<string, unknown> = {}) => ({
  type: 'rent_demand',
  leaseId,
  fields: demandFields,
  ...over,
});

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off', OTP_SENDS_PER_PHONE: 50 });
  today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  const agencyId = await createCompany(api, 'agency', 'Notices API Agency');
  const landlordId = await createCompany(api, 'landlord', 'Notices API Landlord');
  const starterId = await createCompany(api, 'landlord', 'Notices API Starter');
  const platformId = await createCompany(api, 'platform', 'Platform');
  const platformAdmin = await signedIn(platformId, 'admin@platform.invalid', 'platform_admin');
  const plan = await platformAdmin.call(`/platform/companies/${starterId}/plan`, {
    method: 'PUT',
    body: { plan: 'starter' },
  });
  expect(plan.status).toBe(200);
  admin = await signedIn(agencyId, 'admin@notices.invalid', 'agency_admin');
  manager = await signedIn(agencyId, 'manager@notices.invalid', 'property_manager');
  landlord = await signedIn(landlordId, 'landlord@notices.invalid', 'owner');
  starter = await signedIn(starterId, 'starter@notices.invalid', 'owner');
  const owner = await admin.call('/owners', { body: { kind: 'individual', displayName: 'Owner' } });
  const legon = await property('LGN', String(owner.json.id));
  const other = await property('LGO', String(owner.json.id));
  unitId = legon.units[0]!;
  caretaker = await caretakerFor(agencyId, legon.id, '+233200000401');
  otherCaretaker = await caretakerFor(agencyId, other.id, '+233200000402');

  const tenant = await manager.call('/tenants', {
    body: {
      kind: 'individual',
      displayName: 'Notice Tenant',
      phone: TENANT_PHONE,
      consent: { sms: true },
    },
  });
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
      tenantId: (tenant.json.tenant as { id: string }).id,
      startDate: day(-60),
      endDate: endAfter(day(-60), 12),
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name: 'Notice Tenant', paperSignedOn: day(-61) }],
      scanUploadId: String(upload.json.uploadId),
      signedOn: day(-61),
    },
  });
  expect(lease.status, JSON.stringify(lease.json)).toBe(200);
  leaseId = String(lease.json.id);
});

// The ledger behind demand() (see there): billed from the lease's start, as the worker would.
beforeAll(async () => {
  await runSqlWithoutTriggers(
    api.db.superuserUrl,
    'update lease set billing_start_date = start_date where id = $1',
    [leaseId],
  );
  const [row] = await runSqlWithoutTriggers<{ company_id: string }>(
    api.db.superuserUrl,
    'select company_id from lease where id = $1',
    [leaseId],
  );
  await api.app.get(InvoicingService).onLeaseSigned(row!.company_id, leaseId);
  const check = await manager.call('/notices/compose', { body: { type: 'rent_demand', leaseId } });
  expect(check.status, JSON.stringify(check.json)).toBe(200);
  demandFields = (check.json.prefill as { suggestedFields: Record<string, unknown> })
    .suggestedFields;
});

afterAll(async () => {
  await api?.close();
});

describe('LN-01 and OQ-16 over HTTP', () => {
  it('refuses a notice to quit until an admin accepts the current statement, with named codes', async () => {
    const quit = {
      type: 'notice_to_quit',
      subtype: 'arrears',
      leaseId,
      fields: { particulars: 'Rent unpaid', effectiveDate: day(45) },
    };
    const refused = await manager.call('/notices', { body: quit });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: 'NOTICE_QUIT_NOT_ENABLED' });

    const statement = await admin.call('/company/quit-acknowledgement');
    expect(statement.status).toBe(200);
    expect(statement.json).toMatchObject({ enabled: false, mayChange: true });
    const byManager = await manager.call('/company/quit-acknowledgement', {
      body: { statementVersion: CURRENT_QUIT_ACK, typedName: 'Manager' },
    });
    expect(byManager.status).toBe(403);
    const outdated = await admin.call('/company/quit-acknowledgement', {
      body: { statementVersion: 'quit_ack.v0', typedName: 'Admin' },
    });
    expect(outdated.status).toBe(409);
    expect(outdated.json).toMatchObject({ code: 'QUIT_STATEMENT_OUTDATED' });
    const accepted = await admin.call('/company/quit-acknowledgement', {
      body: { statementVersion: CURRENT_QUIT_ACK, typedName: 'Admin Person' },
    });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect(accepted.json).toMatchObject({ enabled: true });
    const again = await admin.call('/company/quit-acknowledgement', {
      body: { statementVersion: CURRENT_QUIT_ACK, typedName: 'Admin Person' },
    });
    expect(again.json).toMatchObject({ code: 'QUIT_ALREADY_ENABLED' });

    const draft = await manager.call('/notices', { body: quit });
    expect(draft.status, JSON.stringify(draft.json)).toBe(200);
    // A notice to quit is never issued by one person (decision 2).
    const issue = await manager.call(`/notices/${String(draft.json.id)}/issue`, { body: {} });
    expect(issue.status).toBe(409);
    expect(issue.json).toMatchObject({ code: 'NOTICE_TWO_PERSON_REQUIRED' });
  });
});

describe('LN-02 drafts, issue and immutability over HTTP', () => {
  it('replays a keyed draft, refuses the key with another body, and freezes an issued notice', async () => {
    const key = { 'idempotency-key': 'notice-draft-0001' };
    const first = await manager.call('/notices', { body: demand(), headers: key });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const replay = await manager.call('/notices', { body: demand(), headers: key });
    expect(replay.json.id).toBe(first.json.id);
    const reused = await manager.call('/notices', {
      body: demand({
        fields: { arrearsMinor: 1, arrearsAsOf: today, invoiceIds: [], payBy: day(14) },
      }),
      headers: key,
    });
    expect(reused.status).toBe(422);
    expect(reused.json).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const id = String(first.json.id);
    const issued = await manager.call(`/notices/${id}/issue`, { body: {} });
    expect(issued.status, JSON.stringify(issued.json)).toBe(200);
    expect(issued.json).toMatchObject({
      status: 'sent',
      number: expect.stringMatching(/^N-\d{6}$/),
    });
    const edit = await manager.call(`/notices/${id}`, {
      method: 'PATCH',
      body: { fields: { arrearsMinor: 1 } },
    });
    expect(edit.status).toBe(409);
    expect(edit.json).toMatchObject({ code: 'NOTICE_FROZEN' });
    const discard = await manager.call(`/notices/${id}/discard`, { body: {} });
    expect(discard.status).toBe(409);
  });
});

describe('Plan 4.11 scope over HTTP', () => {
  it("shows a caretaker their property's notices and tasks only, and another company nothing", async () => {
    const draft = await manager.call('/notices', { body: demand() });
    const id = String(draft.json.id);
    await manager.call(`/notices/${id}/issue`, { body: {} });

    const mine = await caretaker.call(`/notices/${id}`);
    expect(mine.status, JSON.stringify(mine.json)).toBe(200);
    expect(mine.json.actions).toMatchObject({ recordService: true, issue: false });
    expect((await otherCaretaker.call(`/notices/${id}`)).status).toBe(404);
    const theirs = (await otherCaretaker.call('/notices')).json as unknown as { id: string }[];
    expect(theirs.map((n) => n.id)).not.toContain(id);
    expect((await caretaker.call('/notices', { body: demand() })).status).toBe(403);

    expect((await landlord.call(`/notices/${id}`)).status).toBe(404);
    expect((await landlord.call(`/units/${unitId}/rent-assessments`)).status).toBe(404);
    expect((await caretaker.call('/tasks?mine=true')).status).toBe(200);
  });

  it('keeps notices from a company on Starter (decision 14)', async () => {
    const list = await starter.call('/notices');
    expect(list.status).toBe(403);
    expect(list.json).toMatchObject({ code: 'NOT_ON_PLAN' });
    // The composer's catalogue answers, saying the plan leaves notices out, so the web can say so.
    expect((await starter.call('/notices/types')).json).toMatchObject({ onPlan: false });
  });

  it('shows the tenant the notices served on them in the app (plan 4.10)', async () => {
    const tenant = await phoneSignIn(TENANT_PHONE);
    const notices = await tenant.call('/me/notices');
    expect(notices.status, JSON.stringify(notices.json)).toBe(200);
    expect(Array.isArray(notices.json)).toBe(true);
    // Staff routes stay closed to a tenant.
    expect((await tenant.call('/notices')).status).toBe(403);
  });
});
