import { randomUUID } from 'node:crypto';
import { DEV_LINKS_API_KEY, LINKS_API_KEY_HEADER } from '@rent/contracts';
import { runSqlWithoutTriggers } from '@rent/db/testing';
import {
  addDays,
  addMonths,
  businessDateOf,
  instantFrom,
  parseBusinessDate,
  toIsoDate,
} from '@rent/domain/dates';
import { chargeReference } from '@rent/domain/payments';
import { InMemoryPayments } from '@rent/integrations';
import { InvoicingService } from '@rent/server/billing';
import { PAYMENT_PROVIDERS, type PaymentProviders } from '@rent/server/core';
import { DocumentsService } from '@rent/server/documents';
import { PayLinksService, WebhooksService } from '@rent/server/payments';
import { createHmac } from 'node:crypto';
import { withCompany, withSystem, sql } from '@rent/db';
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
 * Provider payments over HTTP (M4b plan 4.3, 4.4 and 4.11): the webhook intake stores the raw
 * request and checks its signature; the pay page's API takes only the links key and answers with
 * the error codes the page words; settlement accounts are masked and revealed only with a reason.
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
let today: string;
let ownerId: string;
let units: { id: string; code: string }[];
let fake: InMemoryPayments;

const links = (path: string, body: unknown, key: string | null = DEV_LINKS_API_KEY) =>
  fetch(`${api.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { [LINKS_API_KEY_HEADER]: key } : {}),
    },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));

const client = { ip: '203.0.113.50', userAgent: 'vitest' };

async function signedIn(email: string, role: 'agency_admin' | 'property_manager') {
  const { personId } = await createPerson(api, { name: email, email, password: PASSWORD });
  await addMembership(api, agencyId, personId, role);
  return (await enrolStaff(api, email, PASSWORD)).device;
}

async function upload(device: Device, path: string, body: Record<string, unknown>) {
  const response = await device.call(path, {
    body: { contentType: 'application/pdf', sizeBytes: PDF.length, ...body },
  });
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
  const response = await manager.call('/leases/paper', {
    body: {
      unitId,
      tenantId: (tenant.json.tenant as { id: string }).id,
      startDate: today,
      endDate: toIsoDate(addDays(addMonths(parseBusinessDate(today), 12), -1)),
      monthlyRentMinor: 100_000,
      cycle: 'monthly',
      noticeDays: 30,
      parties: [{ role: 'tenant', name }],
      scanUploadId: await upload(manager, '/lease-uploads', {}),
      signedOn: today,
      billingStartDate: today,
    },
  });
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  const leaseId = String(response.json.id);
  await api.app.get(InvoicingService).onLeaseSigned(agencyId, leaseId);
  return leaseId;
}

/** A pay link for the lease's first invoice, as a reminder would carry it. */
async function payToken(leaseId: string): Promise<string> {
  const service = api.app.get(PayLinksService);
  const { url } = await withCompany(
    api.database,
    { companyId: agencyId, actorKind: 'system' },
    async (tx) => {
      const invoice = await tx.execute<{ id: string }>(
        sql`select id from invoice where lease_id = ${leaseId} order by due_date limit 1`,
      );
      return service.mint(tx, await service.invoice(tx, invoice.rows[0]!.id));
    },
  );
  return url.split('/p/')[1]!;
}

beforeAll(async () => {
  api = await startApi({ AUTH_RATE_LIMITS: 'off' });
  today = toIsoDate(businessDateOf(instantFrom(new Date()), 'Africa/Accra'));
  agencyId = await createCompany(api, 'agency', 'Payments API Agency');
  admin = await signedIn('admin@payments.invalid', 'agency_admin');
  manager = await signedIn('manager@payments.invalid', 'property_manager');
  const owner = await admin.call('/owners', {
    body: { kind: 'individual', displayName: 'Owner Pay' },
  });
  ownerId = String(owner.json.id);
  const property = await manager.call('/properties', {
    body: {
      areaCode: 'ACC',
      propertyPart: 'PAY',
      name: 'Pay House',
      propertyType: 'compound_house',
      use: 'residential',
      ownerId,
      address: { region: 'Greater Accra', town: 'Legon' },
      units: [{ unitType: 'single_room', count: 4 }],
    },
  });
  units = (property.json.blocks as { units: { id: string; code: string }[] }[])[0]!.units;
  fake = api.app.get<PaymentProviders>(PAYMENT_PROVIDERS).get('paystack') as InMemoryPayments;
  // An account already approved and past its 24 hours (the approval flow is tested in
  // packages/server): written below the application, as a fixture.
  const { subaccountCode } = await fake.createSubaccount({
    businessName: 'Owner Pay',
    settlementBank: 'FAKEBANK1',
    accountNumber: '0123456789',
  });
  const accountId = randomUUID();
  await runSqlWithoutTriggers(
    api.db.superuserUrl,
    `insert into settlement_account (id, company_id, holder, owner_id, bank_code, bank_name, account_name, number_encrypted,
       number_index, number_masked, status, approved_at, usable_from, activated_at)
     values ($1, $2, 'owner', $3, 'FAKEBANK1', 'Test Bank One', 'Owner Pay', '\\x01', 'fixture', '•••• 6789', 'active',
       now() - interval '2 days', now() - interval '1 day', now() - interval '1 day')`,
    [accountId, agencyId, ownerId],
  );
  await runSqlWithoutTriggers(
    api.db.superuserUrl,
    `insert into provider_subaccount (company_id, settlement_account_id, provider, subaccount_code) values ($1, $2, 'paystack', $3)`,
    [agencyId, accountId, subaccountCode],
  );
  await runSqlWithoutTriggers(
    api.db.superuserUrl,
    `insert into management_agreement (company_id, owner_id, destination, effective_from) values ($1, $2, 'owner_account', $3)`,
    [agencyId, ownerId, today],
  );
});

afterAll(async () => {
  await api?.close();
});

describe('BC-02 the webhook intake over HTTP', () => {
  it('stores the raw request, answers 200 for a signed event and 401 for a bad signature', async () => {
    const body = JSON.stringify({
      event: 'charge.success',
      data: { id: 777_001, reference: 'pi-unknownreference', amount: 150000 },
    });
    const signature = createHmac('sha512', 'sk_test_in_memory').update(body).digest('hex');
    const post = (sig: string, provider = 'paystack') =>
      fetch(`${api.baseUrl}/webhooks/${provider}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-paystack-signature': sig },
        body,
      });
    expect((await post(signature)).status).toBe(200);
    expect((await post(signature)).status).toBe(200);
    expect((await post('ab'.repeat(64))).status).toBe(401);
    expect((await post(signature, 'nobody')).status).toBe(404);
    const rows = await withSystem(api.database, {}, (tx) =>
      tx.execute<{ raw_body: string; status: string; signature_valid: boolean }>(
        sql`select raw_body, status, signature_valid from webhook_inbox order by received_at`,
      ),
    );
    expect(rows.rows.map((r) => [r.status, r.signature_valid])).toEqual([
      ['received', true],
      ['rejected', false],
    ]);
    expect(rows.rows[0]!.raw_body).toBe(body);
  });
});

describe('BC-04 the pay page over HTTP', () => {
  it('needs the links key, pays by MoMo, and words refusals with the codes the page knows', async () => {
    const leaseId = await paperLease(units[0]!.id, 'Http Payer');
    const token = await payToken(leaseId);
    expect((await links('/links/pay/open', { token, client }, null)).status).toBe(401);
    const page = await links('/links/pay/open', { token, client });
    expect(page.status, JSON.stringify(page.json)).toBe(200);
    expect(page.json).toMatchObject({ screen: 'pay', dueNowMinor: 100_000 });
    const tooSmall = await links('/links/pay/intents', {
      token,
      client,
      amountMinor: 50,
      method: 'momo',
      momo: { phone: '0240000003', network: 'mtn' },
      submissionId: randomUUID(),
    });
    expect(tooSmall.status).toBe(422);
    expect(String(tooSmall.json.code)).toContain('AMOUNT_TOO_SMALL');
    const badPhone = await links('/links/pay/intents', {
      token,
      client,
      amountMinor: 100_000,
      method: 'momo',
      momo: { phone: '12', network: 'mtn' },
      submissionId: randomUUID(),
    });
    expect(String(badPhone.json.code)).toContain('PHONE');
    const started = await links('/links/pay/intents', {
      token,
      client,
      amountMinor: 100_000,
      method: 'momo',
      momo: { phone: '0240000003', network: 'mtn' },
      submissionId: randomUUID(),
    });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const intentId = String(started.json.intentId);
    const webhook = await fake.completeCharge(chargeReference(intentId), { status: 'success' });
    const delivered = await fetch(`${api.baseUrl}/webhooks/paystack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...webhook!.headers },
      body: webhook!.rawBody,
    });
    expect(delivered.status).toBe(200);
    // The worker's relay and job, here by hand: claim the stored event and process it.
    const inbox = await withSystem(api.database, {}, (tx) =>
      tx.execute<{ id: string }>(sql`select id from app.claim_webhook_inbox(10)`),
    );
    for (const row of inbox.rows) await api.app.get(WebhooksService).process(row.id);
    const status = await links('/links/pay/status', { token, client, intentId });
    expect(status.json).toMatchObject({
      status: 'confirmed',
      receiptNumber: expect.stringMatching(/^RC-/),
    });
    const again = await links('/links/pay/intents', {
      token,
      client,
      amountMinor: 100_000,
      method: 'card',
      submissionId: randomUUID(),
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
    expect(again.status).not.toBe(404);
    expect(String(again.json.code)).toContain('SETTLED');
    const card = await manager.call(`/leases/${leaseId}/billing`);
    expect(card.json).toMatchObject({ dueNowMinor: 0, payLink: { available: false } });
  });
});

describe('ADR-008 settlement accounts over HTTP', () => {
  it('masks the number, asks a second person, and reveals it only with the permission and a reason', async () => {
    const requested = await admin.call('/settlement-accounts', {
      body: {
        holder: 'owner',
        ownerId,
        bankCode: 'FAKEBANK2',
        accountNumber: '1441000123456',
        accountName: 'Owner Pay',
      },
    });
    expect(requested.status, JSON.stringify(requested.json)).toBe(200);
    const account = requested.json.account as Record<string, unknown>;
    expect(account).toMatchObject({ numberMasked: '•••• 3456', status: 'awaiting_approval' });
    expect(JSON.stringify(requested.json)).not.toContain('1441000123456');
    expect(requested.json.approval).toMatchObject({ actionType: 'settlement_account.change' });
    const list = await manager.call('/settlement-accounts');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain('1441000123456');
    const refused = await manager.call(`/settlement-accounts/${String(account.id)}/reveal`, {
      body: { reason: 'Checking the number' },
    });
    expect(refused.status).toBe(403);
    const revealed = await admin.call(`/settlement-accounts/${String(account.id)}/reveal`, {
      body: { reason: 'Checking the number with the owner' },
    });
    expect(revealed.json).toEqual({ accountNumber: '1441000123456' });
  });
});

describe('BC-06 a tenant downloads their own receipt over HTTP (links and tenant e2e)', () => {
  it('serves the tenant’s own receipt PDF, and 404 to another tenant', async () => {
    const created = await manager.call('/tenants', {
      body: {
        kind: 'individual',
        displayName: 'Receipt Downloader',
        phone: '020 000 0421',
        consent: { sms: true },
      },
    });
    const tenantId = (created.json.tenant as { id: string }).id;
    const lease = await manager.call('/leases/paper', {
      body: {
        unitId: units[2]!.id,
        tenantId,
        startDate: today,
        endDate: toIsoDate(addDays(addMonths(parseBusinessDate(today), 12), -1)),
        monthlyRentMinor: 100_000,
        cycle: 'monthly',
        noticeDays: 30,
        parties: [{ role: 'tenant', name: 'Receipt Downloader' }],
        scanUploadId: await upload(manager, '/lease-uploads', {}),
        signedOn: today,
        billingStartDate: today,
      },
    });
    expect(lease.status, JSON.stringify(lease.json)).toBe(200);
    const leaseId = String(lease.json.id);
    await api.app.get(InvoicingService).onLeaseSigned(agencyId, leaseId);
    // Paid through the pay page, the webhook processed as the worker would.
    const token = await payToken(leaseId);
    const started = await links('/links/pay/intents', {
      token,
      client,
      amountMinor: 100_000,
      method: 'momo',
      momo: { phone: '0240000004', network: 'mtn' },
      submissionId: randomUUID(),
    });
    const webhook = await fake.completeCharge(chargeReference(String(started.json.intentId)), {
      status: 'success',
    });
    await fetch(`${api.baseUrl}/webhooks/paystack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...webhook!.headers },
      body: webhook!.rawBody,
    });
    const inbox = await withSystem(api.database, {}, (tx) =>
      tx.execute<{ id: string }>(sql`select id from app.claim_webhook_inbox(10)`),
    );
    for (const row of inbox.rows) await api.app.get(WebhooksService).process(row.id);
    const receipt = await withCompany(
      api.database,
      { companyId: agencyId, actorKind: 'system' },
      (tx) =>
        tx.execute<{ id: string; render_request_id: string }>(
          sql`select id, render_request_id from receipt where lease_id = ${leaseId} and kind = 'receipt'`,
        ),
    );
    const { id: receiptId, render_request_id: renderRequestId } = receipt.rows[0]!;
    // The worker's PDF job, with a stand-in renderer.
    await api.app.get(DocumentsService).renderRequested(agencyId, renderRequestId, async () => PDF);
    const signIn = async (phone: string) => {
      const device = new Device(api.baseUrl, 'Expo/Android');
      await device.call('/api/auth/phone-number/send-otp', { body: { phoneNumber: phone } });
      const code = /\b(\d{6})\b/.exec(api.sms.lastTo(phone)!.body)![1]!;
      const verified = await device.call('/api/auth/phone-number/verify', {
        body: { phoneNumber: phone, code },
      });
      expect(verified.status).toBe(200);
      return device;
    };
    const tenant = await signIn('+233200000421');
    const download = await tenant.call(`/me/receipts/${receiptId}/download`);
    expect(download.status, JSON.stringify(download.json)).toBe(200);
    expect(String(download.json.url)).toMatch(/^memory:\/\/download\//);
    await createPerson(api, { name: 'Another tenant', phone: '+233200000422' });
    const stranger = await signIn('+233200000422');
    expect((await stranger.call(`/me/receipts/${receiptId}/download`)).status).toBe(404);
  });
});
