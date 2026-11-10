import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { jobForNewArtisan } from './job-sheet-support';
import {
  accraToday,
  completeCharge,
  leaseDueToday,
  linkPathIn,
  openInvoice,
  pendingMomoCharge,
  sendPayLink,
  smsSince,
  termEnd,
  type PayLease,
} from './pay-support';
import { freshPhone, issuedLease, newProperty, ok, pathOf, waitForSms } from './signing-support';

/**
 * Real links pages in their main states, for the M11 page checks (axe and Lighthouse): each made
 * through the API as staff make it, with its link taken as the tenant gets it. Every call makes
 * its own tenant, lease or job, so nothing depends on another run. After the spec files that
 * first wrote these flows (pay, signing, notice-signing, unsubscribe, job-sheet), which stay as
 * they are.
 */
export interface PayLink {
  readonly lease: PayLease;
  readonly path: string;
}

/** A lease due today, an open invoice, and the pay link the tenant gets by SMS. */
export async function payLink(api: APIRequestContext, tenantName: string): Promise<PayLink> {
  const lease = await leaseDueToday(api, tenantName, 120_000);
  const invoiceId = await openInvoice(api, lease.leaseId);
  return { lease, path: await sendPayLink(api, invoiceId, lease.tenantPhone) };
}

/**
 * The tenant pays what is due by MTN MoMo on the pay page and approves the prompt; the page
 * thanks them, and the receipt link arrives by SMS. Leaves `page` on the pay page.
 * `whileWaiting` runs on the waiting step, once the page checks again by itself.
 */
export async function payByMomo(
  page: Page,
  link: PayLink,
  whileWaiting?: () => Promise<void>,
): Promise<string> {
  await page.goto(link.path);
  await page.getByLabel('MTN MoMo', { exact: true }).check();
  await page.getByLabel('MoMo number to charge').fill(`0${link.lease.tenantPhone.slice(4)}`);
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Approve the payment on your phone',
  );
  if (whileWaiting) {
    await expect(page.getByText(/^This page checks again every \d+ seconds\.$/)).toBeVisible();
    await whileWaiting();
  }
  const charge = await pendingMomoCharge(link.lease.tenantPhone);
  const approvedAt = Date.now();
  await completeCharge(charge.reference);
  await expect(
    page.locator('main').getByRole('status').filter({ hasText: 'Thank you' }),
  ).toBeVisible({ timeout: 45_000 });
  const receipt = await smsSince(link.lease.tenantPhone, /receipt/i, approvedAt - 1_000, 75_000);
  const path = linkPathIn(receipt.body);
  if (!path) throw new Error('the receipt SMS carries no link');
  return path;
}

/**
 * A lease issued for e-signing; the tenant's signing page, from the link in the invitation SMS, as
 * signing.spec takes it. A hand-over link made before the worker sends the invitation is replaced
 * by the invitation's own link, so the page would say "replaced" once the code is asked for.
 */
export async function leaseSigningLink(api: APIRequestContext): Promise<string> {
  return (await leaseSigningFor(api)).path;
}

/** As leaseSigningLink, with the tenant's phone, where the signing code goes. */
export async function leaseSigningFor(
  api: APIRequestContext,
): Promise<{ readonly path: string; readonly phone: string }> {
  const [unit] = await newProperty(api, 1);
  const lease = await issuedLease(api, unit!.id, 'Ama Signs-Lease (e2e)');
  return { path: pathOf(await waitForSms(lease.tenantPhone, /\/l\//)), phone: lease.tenantPhone };
}

const inDays = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** A notice of entry issued on a new lease; the tenant's page, once its PDF is frozen. */
export async function noticeLink(api: APIRequestContext): Promise<string> {
  return (await noticeFor(api)).path;
}

/** As noticeLink, with the tenant's phone, where the signing code goes. */
export async function noticeFor(
  api: APIRequestContext,
): Promise<{ readonly path: string; readonly phone: string }> {
  const lease = await leaseDueToday(api, 'Kofi Reads-Notices (e2e)', 120_000);
  const draft = await ok<{ id: string }>(
    await api.post('/notices', {
      data: {
        type: 'entry',
        subtype: 'inspection',
        leaseId: lease.leaseId,
        fields: { entryDate: inDays(10), windowFrom: '10:00', windowTo: '12:00' },
      },
    }),
    'draft a notice of entry',
  );
  const notice = await ok<{ id: string; recipients: { id: string }[] }>(
    await api.post(`/notices/${draft.id}/issue`, { data: {} }),
    'issue it',
  );
  let path = '';
  await expect
    .poll(
      async () => {
        const response = await api.post(
          `/notices/${notice.id}/recipients/${notice.recipients[0]!.id}/link`,
          { data: {} },
        );
        if (response.status() !== 200) return false;
        const { url } = (await response.json()) as { url: string };
        path = /\/l\/[A-Za-z0-9_-]{43}/.exec(url)?.[0] ?? '';
        return path !== '';
      },
      { message: 'the notice’s PDF is frozen and its link opens', timeout: 60_000 },
    )
    .toBe(true);
  return { path, phone: lease.tenantPhone };
}

/** A repair given to a new artisan; their job sheet page. */
export async function jobSheetLink(api: APIRequestContext): Promise<string> {
  return (await jobSheetFor(api)).path;
}

/** As jobSheetLink, with the artisan's phone, where the completion code goes. */
export async function jobSheetFor(api: APIRequestContext) {
  return jobForNewArtisan(api, `The bathroom tap drips. (e2e ${Date.now()})`);
}

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const UNSUBSCRIBE_PATH = /\/u\/([A-Za-z0-9_-]{43})/;

/** A tenant with email consent, written to by email; the unsubscribe page in that email. */
export async function unsubscribeLink(api: APIRequestContext): Promise<string> {
  const address = `page-check-${randomUUID()}@example.test`;
  const sentAfter = Date.now();
  const saved = await ok<{ tenant: { id: string } }>(
    await api.post('/tenants', {
      data: {
        kind: 'individual',
        displayName: 'Esi Reads-Email (e2e)',
        phone: freshPhone(),
        email: address,
        consent: { email: true },
      },
    }),
    'create a tenant with email consent',
  );
  const conversation = await ok<{ id: string }>(
    await api.post(`/tenants/${saved.tenant.id}/conversation`, { data: {} }),
    'open the tenant’s conversation',
  );
  await ok(
    await api.post(`/conversations/${conversation.id}/replies`, {
      data: {
        clientMessageId: randomUUID(),
        channel: 'email',
        subject: 'Water off on Saturday',
        body: 'The water will be off on Saturday from 9 to 12 for repairs.',
      },
    }),
    'write to the tenant by email',
  );
  let token = '';
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=5`,
        );
        const { messages } = (await search.json()) as {
          messages: { ID: string; Created: string }[];
        };
        const newest = messages.find((m) => Date.parse(m.Created) >= sentAfter - 1_000);
        if (!newest) return false;
        const headers = (await (
          await fetch(`${MAILPIT}/api/v1/message/${newest.ID}/headers`)
        ).json()) as Record<string, string[]>;
        const listUnsubscribe = Object.entries(headers)
          .filter(([name]) => name.toLowerCase() === 'list-unsubscribe')
          .flatMap(([, values]) => values)
          .join(' ');
        const message = (await (await fetch(`${MAILPIT}/api/v1/message/${newest.ID}`)).json()) as {
          Text: string;
        };
        token =
          UNSUBSCRIBE_PATH.exec(listUnsubscribe)?.[1] ??
          UNSUBSCRIBE_PATH.exec(message.Text)?.[1] ??
          '';
        return token !== '';
      },
      { message: 'an email with an unsubscribe link reaches the tenant', timeout: 45_000 },
    )
    .toBe(true);
  return `/u/${token}`;
}

const PAPER_SCAN = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * A second tenancy for the tenant of `leaseId`: a paper lease of another room of the same agency,
 * starting today, so Home shows two tenancies (the tenant app's layout check, M11 review).
 */
export async function anotherLeaseFor(api: APIRequestContext, leaseId: string): Promise<string> {
  const lease = await ok<{ tenant: { id: string; displayName: string } }>(
    await api.get(`/leases/${leaseId}`),
    'the lease',
  );
  const [unit] = await newProperty(api, 1);
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
  const second = await ok<{ id: string }>(
    await api.post('/leases/paper', {
      data: {
        unitId: unit!.id,
        tenantId: lease.tenant.id,
        startDate: start,
        endDate: termEnd(start, 12),
        monthlyRentMinor: 90_000,
        cycle: 'monthly',
        depositMinor: null,
        serviceChargeMonthlyMinor: null,
        steps: [],
        noticeDays: 30,
        parties: [{ role: 'tenant', name: lease.tenant.displayName, paperSignedOn: start }],
        scanUploadId: slot.uploadId,
        signedOn: start,
      },
    }),
    'record a second paper lease',
  );
  return second.id;
}
