import { schema, sql, withCompany } from '@rent/db';
import { DEV_LINKS_API_KEY as CONTRACT_DEV_KEY, LINKS_API_KEY_HEADER } from '@rent/contracts';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { CURRENT_CONSENT } from '@rent/domain/esign';
import { DEV_LINKS_API_KEY as SERVER_DEV_KEY } from '@rent/server/core';
import { DocumentsService } from '@rent/server/documents';
import { EsignService } from '@rent/server/esign';
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
const CLIENT = { ip: '203.0.113.40', userAgent: 'Mozilla/5.0 (Linux; Android 14)' };

let api: TestApi;
let agencyId: string;
let manager: Device;
let admin: Device;
let units: { id: string; code: string }[];
let today: string;
const month = (n: number) => toIsoDate(addMonths(parseBusinessDate(today), n));
const endAfter = (from: string, months: number) =>
  toIsoDate(addDays(addMonths(parseBusinessDate(from), months), -1));

/** apps/links, calling the links API with its key. */
async function links(path: string, body: unknown, key: string | null = DEV_LINKS_API_KEY) {
  const response = await fetch(`${api.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { [LINKS_API_KEY_HEADER]: key }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    setCookie: response.headers.getSetCookie(),
  };
}
const DEV_LINKS_API_KEY = CONTRACT_DEV_KEY;
const tokenOf = (url: unknown) => /\/l\/([A-Za-z0-9_-]{43})$/.exec(String(url))![1]!;

/** What the worker does once a lease is issued: render its PDF, then open the request. */
async function renderAndOpen() {
  const documents = api.app.get(DocumentsService);
  const esign = api.app.get(EsignService);
  const pending = await withCompany(
    api.database,
    { companyId: agencyId, actorKind: 'system' },
    (tx) =>
      tx
        .select({ id: schema.documentRenderRequest.id })
        .from(schema.documentRenderRequest)
        .where(sql`${schema.documentRenderRequest.status} = 'pending'`),
  );
  for (const { id } of pending) {
    await documents.renderRequested(agencyId, id, async () =>
      Buffer.from('%PDF-1.4\n% a stand-in for the rendered lease\n%%EOF\n', 'latin1'),
    );
    await esign.onDocumentRendered(agencyId, id);
  }
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  agencyId = await createCompany(api, 'agency', 'Signing API Agency');
  const { personId: adminId } = await createPerson(api, {
    name: 'Admin',
    email: 'admin@esign.invalid',
    password: PASSWORD,
  });
  await addMembership(api, agencyId, adminId, 'agency_admin');
  admin = (await enrolStaff(api, 'admin@esign.invalid', PASSWORD)).device;
  const { personId } = await createPerson(api, {
    name: 'Kofi Manager',
    email: 'manager@esign.invalid',
    password: PASSWORD,
  });
  await addMembership(api, agencyId, personId, 'property_manager');
  manager = (await enrolStaff(api, 'manager@esign.invalid', PASSWORD)).device;
  const owner = await admin.call('/owners', { body: { kind: 'individual', displayName: 'Owner' } });
  const property = await manager.call('/properties', {
    body: {
      areaCode: 'ACC',
      propertyPart: 'SIG',
      name: 'Signing flats',
      propertyType: 'apartment_block',
      use: 'residential',
      ownerId: owner.json.id,
      address: { region: 'Greater Accra', town: 'Osu' },
      units: [{ unitType: 'apartment', count: 2, bedrooms: 2 }],
    },
  });
  units = (property.json.blocks as { units: { id: string; code: string }[] }[])[0]!.units;
});

afterAll(async () => {
  await api?.close();
});

describe('TL-07 signing engine over HTTP', () => {
  it('uses one development links key on both sides, and refuses callers without it', async () => {
    expect(CONTRACT_DEV_KEY).toBe(SERVER_DEV_KEY);
    const body = { token: 'a'.repeat(43), client: CLIENT };
    expect((await links('/links/open', body, null)).status).toBe(401);
    expect((await links('/links/open', body, 'wrong-key')).status).toBe(401);
    const unknown = await links('/links/open', body);
    expect(unknown.status).toBe(404);
    expect(unknown.setCookie).toEqual([]);
    // A staff session is no substitute for the key.
    expect((await manager.call('/links/open', { body })).status).toBe(401);
  });

  it('issues a lease, hands a link over, sends a code only to the phone on record, signs and recalls', async () => {
    const phone = '+233200711001';
    const tenant = await manager.call('/tenants', {
      body: {
        kind: 'individual',
        displayName: 'HTTP Tenant',
        phone,
        consent: { sms: true },
      },
    });
    expect(tenant.status, JSON.stringify(tenant.json)).toBe(200);
    const tenantId = String((tenant.json.tenant as { id: string }).id);
    const draft = await manager.call('/leases', {
      body: {
        unitId: units[0]!.id,
        tenantId,
        startDate: month(2),
        endDate: endAfter(month(2), 12),
        monthlyRentMinor: 120_000,
        cycle: 'monthly',
        noticeDays: 30,
      },
    });
    expect(draft.status, JSON.stringify(draft.json)).toBe(200);
    const leaseId = String(draft.json.id);
    const parties = (draft.json.parties as Record<string, unknown>[]).map((p) => ({
      role: p.role,
      name: p.name,
      phone: p.phone,
      email: p.email,
      tenantContactId: p.tenantContactId,
      staffPersonId: p.staffPersonId,
    }));
    await manager.call(`/leases/${leaseId}`, {
      method: 'PATCH',
      body: {
        parties: [...parties, { role: 'witness', name: 'HTTP Witness', phone: '+233200711002' }],
      },
    });

    const issued = await manager.call(`/leases/${leaseId}/issue`, { body: {} });
    expect(issued.status, JSON.stringify(issued.json)).toBe(200);
    expect(issued.json.status).toBe('pending_signatures');
    const preparing = await manager.call(`/leases/${leaseId}/signing`);
    expect(preparing.json).toMatchObject({ status: 'preparing', frozenDocument: false });

    await renderAndOpen();
    const progress = await manager.call(`/leases/${leaseId}/signing`);
    expect(progress.json).toMatchObject({ status: 'pending', frozenDocument: true });
    const signers = progress.json.signers as { id: string; role: string; codeChannel: string }[];
    expect(signers.map((x) => x.role)).toEqual(['tenant', 'landlord', 'witness']);
    const tenantSigner = signers[0]!;
    const requestId = String(progress.json.requestId);

    const handover = await manager.call(
      `/signing-requests/${requestId}/signers/${tenantSigner.id}/link`,
      { body: {} },
    );
    expect(handover.status, JSON.stringify(handover.json)).toBe(200);
    expect(handover.json.url).toMatch(/^http:\/\/localhost:3702\/l\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(handover.json.url);

    const opened = await links('/links/open', { token, client: CLIENT });
    expect(opened.status).toBe(200);
    expect(opened.json).toMatchObject({
      screen: 'sign',
      signer: { role: 'tenant', name: 'HTTP Tenant' },
      code: { channel: 'sms', destinationMasked: '+233 ** *** 1001' },
      consent: { version: CURRENT_CONSENT },
    });
    expect(String((opened.json.document as { html: string }).html)).toContain('HTTP Tenant');

    // The page cannot choose where the code goes: an extra destination is refused outright.
    const steered = await links('/links/code', {
      token,
      client: CLIENT,
      phone: '+233200799999',
    });
    expect(steered.status).toBe(400);
    const sent = await links('/links/code', { token, client: CLIENT });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json).toMatchObject({ channel: 'sms', destinationMasked: '+233 ** *** 1001' });
    expect(api.sms.lastTo('+233200799999')).toBeUndefined();
    const code = /^(\d{6}) is your code/.exec(api.sms.lastTo(phone)!.body)![1]!;

    const wrong = await links('/links/sign', {
      token,
      client: CLIENT,
      code: code === '000000' ? '111111' : '000000',
      method: 'typed',
      typedName: 'HTTP Tenant',
      consentVersion: CURRENT_CONSENT,
      consentAccepted: true,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.json).toMatchObject({ code: 'CODE_WRONG', data: { attemptsLeft: '4' } });
    const signed = await links('/links/sign', {
      token,
      client: CLIENT,
      code,
      method: 'typed',
      typedName: 'HTTP Tenant',
      consentVersion: CURRENT_CONSENT,
      consentAccepted: true,
    });
    expect(signed.status, JSON.stringify(signed.json)).toBe(200);
    expect(signed.json).toMatchObject({ complete: false });
    expect((await links('/links/open', { token, client: CLIENT })).json).toMatchObject({
      screen: 'signed',
    });
    expect((await links('/links/code', { token, client: CLIENT })).status).toBe(409);

    const document = await links('/links/document', { token, client: CLIENT });
    expect(document.status).toBe(200);
    expect(String(document.json.url)).toMatch(/^memory:\/\/download\//);
    const frozen = await manager.call(`/leases/${leaseId}/signing/document?which=frozen`);
    expect(frozen.status).toBe(200);

    const recalled = await manager.call(`/leases/${leaseId}/recall`, {
      body: { reason: 'Rent agreed again' },
    });
    expect(recalled.status, JSON.stringify(recalled.json)).toBe(200);
    expect(recalled.json.status).toBe('draft');
    expect((await manager.call(`/leases/${leaseId}/signing`)).json).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Rent agreed again',
    });
    expect((await links('/links/open', { token, client: CLIENT })).json).toMatchObject({
      screen: 'signed',
    });
  });
});

describe('TL-07 signing reminders as a company setting', () => {
  it('shows the M3 settings in force, defaults applied, and lets an admin change the signing ladder', async () => {
    const before = await admin.call('/company');
    expect(before.status).toBe(200);
    expect(before.json.settings).toMatchObject({
      witnessRequired: true,
      rentControlCommercial: false,
      rentControlReminderDaysBefore: [7, 2, 0],
      stampingReminderDaysBefore: [30, 14, 7],
      signingReminderHours: [24, 72, 168],
    });
    const changed = await admin.call('/company/settings', {
      method: 'PATCH',
      body: { signingReminderHours: [12, 48], witnessRequired: false },
    });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    expect(changed.json.settings).toMatchObject({
      signingReminderHours: [12, 48],
      witnessRequired: false,
      renewalReminderDays: [90, 60, 30],
    });
    const refused = await admin.call('/company/settings', {
      method: 'PATCH',
      body: { signingReminderHours: [0] },
    });
    expect(refused.status).toBe(400);
    await admin.call('/company/settings', {
      method: 'PATCH',
      body: { signingReminderHours: [24, 72, 168], witnessRequired: true },
    });
  });
});
