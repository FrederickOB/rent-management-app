import { expect, type APIRequestContext } from '@playwright/test';
import { API, freshPhone, newProperty, ok, smsTo, waitForSms } from './signing-support';

/**
 * Helpers for the pay page specs (BC-04, BC-06). Staff act through the API as the seeded demo
 * manager; the tenant pays through the fake provider, whose test controls approve a MoMo prompt
 * as the tenant's phone would. Every run makes its own property, tenant and lease, on a fresh
 * phone, so nothing depends on an earlier run.
 */
const FAKE_PROVIDERS = process.env.FAKE_PROVIDERS_URL ?? 'http://localhost:4010';
/** The fake's development key (apps/fake-providers); not a secret. */
const FAKE_PAYMENTS_KEY = process.env.FAKE_PAYMENTS_SECRET_KEY || 'sk_test_fake_providers_dev_only';

export { API, freshPhone, ok, smsTo };

/** Today in Accra, the demo agency's time zone, as YYYY-MM-DD. */
export function accraToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Accra' }).format(new Date());
}

/** The last day of a term of `months` months from `start`. */
export function termEnd(start: string, months: number): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const end = new Date(Date.UTC(y, m - 1 + months, d - 1));
  return end.toISOString().slice(0, 10);
}

const PAPER_SCAN = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
);

export interface PayLease {
  readonly leaseId: string;
  readonly tenantPhone: string;
  readonly unitCode: string;
  readonly monthlyRentMinor: number;
}

/**
 * A tenant with SMS consent (so the pay link and the receipt go by SMS) on a monthly lease of the
 * agency's owner OWN-01, signed on paper and starting today, so its first month is due now.
 */
export async function leaseDueToday(
  api: APIRequestContext,
  tenantName: string,
  monthlyRentMinor: number,
): Promise<PayLease> {
  const [unit] = await newProperty(api, 1);
  const tenantPhone = freshPhone();
  const tenant = await ok<{ tenant: { id: string } }>(
    await api.post('/tenants', {
      data: {
        kind: 'individual',
        displayName: tenantName,
        phone: tenantPhone,
        consent: { sms: true },
      },
    }),
    'create a tenant',
  );
  const slot = await ok<{ uploadId: string; url: string; fields: Record<string, string> }>(
    await api.post('/lease-uploads', {
      data: { contentType: 'application/pdf', sizeBytes: PAPER_SCAN.length },
    }),
    'ask for an upload',
  );
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', new Blob([PAPER_SCAN], { type: 'application/pdf' }), 'paper-lease.pdf');
  const stored = await fetch(slot.url, { method: 'POST', body: form });
  expect(stored.ok, `upload the scan: ${stored.status}`).toBe(true);
  const start = accraToday();
  const lease = await ok<{ id: string }>(
    await api.post('/leases/paper', {
      data: {
        unitId: unit!.id,
        tenantId: tenant.tenant.id,
        startDate: start,
        endDate: termEnd(start, 12),
        monthlyRentMinor,
        cycle: 'monthly',
        depositMinor: null,
        serviceChargeMonthlyMinor: null,
        steps: [],
        noticeDays: 30,
        parties: [{ role: 'tenant', name: tenantName, paperSignedOn: start }],
        scanUploadId: slot.uploadId,
        signedOn: start,
      },
    }),
    'record the paper lease',
  );
  return { leaseId: lease.id, tenantPhone, unitCode: unit!.code, monthlyRentMinor };
}

interface InvoiceRow {
  readonly id: string;
  readonly kind: string;
  readonly outstandingMinor: number;
}

/** The lease's open rent invoice, once billing has issued it. */
export async function openInvoice(api: APIRequestContext, leaseId: string): Promise<string> {
  let found: InvoiceRow | undefined;
  await expect
    .poll(
      async () => {
        const rows = await ok<InvoiceRow[]>(
          await api.get(`/invoices?leaseId=${leaseId}`),
          'the lease’s invoices',
        );
        found = rows.find((r) => r.kind === 'cycle' && r.outstandingMinor > 0);
        return Boolean(found);
      },
      { message: 'billing issues the first month’s invoice', timeout: 45_000 },
    )
    .toBe(true);
  return found!.id;
}

/** The lease's money as staff see it (AR-02): due now, paid-until and credit, in pesewas. */
export async function leaseBilling(api: APIRequestContext, leaseId: string) {
  return ok<{ dueNowMinor: number; paidUntil: string | null; creditMinor: number }>(
    await api.get(`/leases/${leaseId}/billing`),
    'the lease’s billing',
  );
}

const LINK_IN_TEXT = /https?:\/\/[^\s/]+(\/[a-z]+\/[A-Za-z0-9_-]{43})\b/;

/** The page path of the links URL in a message, as the API wrote it, or null. */
export function linkPathIn(text: string): string | null {
  return LINK_IN_TEXT.exec(text)?.[1] ?? null;
}

/**
 * Staff send the tenant a pay link for an invoice (BC-04); the page path in the SMS that brings
 * it. The path is taken as the API wrote it, so the spec checks the API and the page agree.
 */
export async function sendPayLink(
  api: APIRequestContext,
  invoiceId: string,
  tenantPhone: string,
): Promise<string> {
  const before = Date.now();
  const sent = await ok<{ channels: string[]; notSentReason: string | null }>(
    await api.post(`/invoices/${invoiceId}/pay-link`, { data: {} }),
    'send the pay link',
  );
  expect(sent.notSentReason, 'the lease has a usable settlement destination').toBeNull();
  expect(sent.channels).toContain('sms');
  const body = await waitForSms(tenantPhone, LINK_IN_TEXT, before - 1_000);
  return LINK_IN_TEXT.exec(body)![1]!;
}

interface FakeTransaction {
  readonly reference: string;
  readonly status: string;
  readonly amount: number;
  readonly channel: string;
  readonly created_at: string;
  readonly customer: { readonly phone: string | null };
}

/** The fake provider's charges in the last hour, as Paystack lists them (with its key). */
async function charges(): Promise<FakeTransaction[]> {
  const to = new Date(Date.now() + 60_000).toISOString();
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const response = await fetch(
    `${FAKE_PROVIDERS}/payments/transaction?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { headers: { authorization: `Bearer ${FAKE_PAYMENTS_KEY}` } },
  );
  expect(response.status, 'list the fake provider’s charges').toBe(200);
  return ((await response.json()) as { data: FakeTransaction[] }).data;
}

/** Every charge the fake provider holds for a phone (E.164), whatever its status. */
export async function chargesTo(phone: string): Promise<FakeTransaction[]> {
  return (await charges()).filter((tx) => tx.customer.phone === phone);
}

/** The pending MoMo charge the pay page started for a phone (E.164), waiting for it. */
export async function pendingMomoCharge(phone: string): Promise<FakeTransaction> {
  let found: FakeTransaction | undefined;
  await expect
    .poll(
      async () => {
        found = (await charges()).find(
          (tx) => tx.customer.phone === phone && tx.status === 'pending',
        );
        return Boolean(found);
      },
      { message: `a MoMo prompt to ${phone.slice(0, 7)}… reaches the fake provider` },
    )
    .toBe(true);
  return found!;
}

/** The tenant approves (or declines) a charge, as their phone or the card checkout would. */
export async function completeCharge(
  reference: string,
  status: 'success' | 'failed' = 'success',
): Promise<void> {
  const response = await fetch(
    `${FAKE_PROVIDERS}/payments/_test/charges/${encodeURIComponent(reference)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    },
  );
  expect(response.status, `complete the charge: ${await response.text()}`).toBe(200);
}

/** The newest SMS to a phone that matches, sent since `after`, with when it was sent. */
export async function smsSince(
  phone: string,
  pattern: RegExp,
  after: number,
  timeout = 60_000,
): Promise<{ body: string; at: number }> {
  let found: { body: string; at: number } | null = null;
  await expect
    .poll(
      async () => {
        const message = (await smsTo(phone)).find(
          (m) => pattern.test(m.body) && Date.parse(m.at) >= after,
        );
        found = message ? { body: message.body, at: Date.parse(message.at) } : null;
        return found !== null;
      },
      { message: `an SMS matching ${pattern}`, timeout },
    )
    .toBe(true);
  return found!;
}
