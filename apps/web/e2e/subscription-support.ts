import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import type { SubscriptionTier } from '@rent/domain/settings';
import { codeFor, DEMO_PASSWORD, ready, signIn, submitAuth, unique } from './helpers';
import { fixture, freePropertyPart } from './register-helpers';
import { freshPhone, newTenant, recordPaperLease, today } from './tenancy-helpers';

/**
 * Helpers for the M10 specs (plan section 6, web). Each spec makes its own company: the platform
 * admin onboards it through the API, and its first admin accepts the emailed invitation, sets a
 * password and enrols TOTP through the real screens. Nothing depends on the seed's subscriptions.
 *
 * What they rely on:
 *
 * A1. The API's test control forces a subscription invoice, the one state no screen can reach in
 *     a test: `POST /api/v1/_test/subscriptions/{companyId}/invoice` with `{ dueDaysAgo }`, by a
 *     platform admin, mounted only with E2E_TEST_CONTROLS=on (apps/api/src/admin/
 *     test-controls.controller.ts). It issues an open invoice through the normal invoice path,
 *     due `dueDaysAgo` days ago, then runs today's dunning, so 15 days makes the company read-only
 *     (grace 14, the switch on). It answers `{ id, number, totalMinor }`. Not in the contracts.
 * A2. The fake provider takes platform charges with no subaccount: `checkoutUrl` opens the same
 *     "Fake checkout" page as rent, whose "Pay" button completes the charge and sends the webhook,
 *     and the API issues the receipt within the subscription page's polling.
 * A3. Onboarding emails the first admin the same set-password link staff invitations use
 *     (Better Auth's reset flow, through Mailpit), and the admin then enrols TOTP.
 * A4. The seeded platform admin is `admin@demo.invalid`, on the demo TOTP.
 * A5. Read-only (decision 11) refuses adding an owner with 403 `SUBSCRIPTION_READ_ONLY`, and
 *     allows recording cash, its photo upload included (it then waits for a second person).
 * A6. A MoMo payment's charge at the fake provider carries the payment's `SUB-` reference, so the
 *     fake's test control approves it as the payer's phone would.
 * A7. Billing is on in the e2e database (the seed turns it on with demo prices, founder answer
 *     Q1), so a company onboarded here starts its trial at once and can be invoiced.
 */

export const PLATFORM_ADMIN = { email: 'admin@demo.invalid', name: 'Platform Admin (demo)' };

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

export async function ok<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string,
): Promise<T> {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

export interface Onboarded {
  readonly companyId: string;
  readonly name: string;
  readonly adminEmail: string;
  readonly adminName: string;
}

/** A new company, onboarded by the platform admin through the API (decision 14). */
export async function onboard(
  platform: Page,
  options: {
    readonly kind: 'agency' | 'landlord';
    readonly tier: SubscriptionTier;
    readonly trialDays?: number;
  },
): Promise<Onboarded> {
  const tag = unique();
  const name = `M10 ${options.kind === 'agency' ? 'Agency' : 'Landlord'} ${tag} (e2e)`;
  const adminEmail = `m10.${tag.toLowerCase()}@demo.invalid`;
  const adminName = `Ama Admin ${tag} (e2e)`;
  const created = await ok<{ company: { id: string } }>(
    await platform.request.post('/api/v1/platform/companies', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        kind: options.kind,
        name,
        timeZone: 'Africa/Accra',
        tier: options.tier,
        ...(options.trialDays === undefined ? {} : { trialDays: options.trialDays }),
        adminName,
        adminEmail,
      },
    }),
    'onboard a company',
  );
  return { companyId: created.company.id, name, adminEmail, adminName };
}

/** The set-password token in the newest email to an address (A3), read from Mailpit. */
export async function invitationToken(address: string): Promise<string> {
  let token = '';
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=5`,
        );
        const { messages } = (await search.json()) as { messages: { ID: string }[] };
        const newest = messages[0];
        if (!newest) return false;
        const message = (await (await fetch(`${MAILPIT}/api/v1/message/${newest.ID}`)).json()) as {
          Text: string;
        };
        const link = /https?:\/\/\S+/.exec(message.Text)?.[0] ?? '';
        token =
          /reset-password\/([^?\s/]+)/.exec(link)?.[1] ??
          /[?&]token=([^&\s]+)/.exec(link)?.[1] ??
          '';
        return token !== '';
      },
      { message: `an invitation emailed to ${address}`, timeout: 30_000 },
    )
    .toBe(true);
  return token;
}

/**
 * The onboarded company's first admin, through the real screens: the invitation link, a new
 * password, then TOTP enrolment. Returns their signed-in context, page and TOTP secret.
 */
export async function firstAdmin(
  browser: Browser,
  baseURL: string | undefined,
  company: Onboarded,
): Promise<{ context: BrowserContext; page: Page; secret: string }> {
  const token = await invitationToken(company.adminEmail);
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/accept-invite?token=${encodeURIComponent(token)}`);
  await ready(page, 'Set password');
  await page.getByLabel('New password').fill(DEMO_PASSWORD);
  await page.getByLabel('Repeat the password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('Your password is set')).toBeVisible();

  await page.goto('/sign-in');
  await ready(page, 'Sign in');
  await page.getByLabel('Email', { exact: true }).fill(company.adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
  const signedIn = await submitAuth(page, '/api/auth/sign-in/email', () =>
    page.getByRole('button', { name: 'Sign in' }).click(),
  );
  expect(signedIn.status(), 'the new admin signs in with the new password').toBe(200);
  await expect(page).toHaveURL(/\/enrol$/);
  await ready(page, 'Continue');
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  const secret = (await page.getByTestId('totp-secret').innerText()).replace(/\s+/g, '');
  await page.getByRole('button', { name: 'I have added it' }).click();
  await page.getByLabel('I have saved these backup codes').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  const confirmed = await submitAuth(page, '/api/auth/two-factor/verify-totp', async () => {
    await page.getByLabel('6-digit code').fill(await codeFor(secret));
    await page.getByRole('button', { name: 'Confirm' }).click();
  });
  expect(confirmed.status(), 'the new admin enrols TOTP').toBe(200);
  await expect(page.getByTestId('shell-person')).toHaveText(company.adminName);
  return { context, page, secret };
}

/** The platform admin, signed in on a context of their own. */
export async function platformAdmin(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signIn(page, PLATFORM_ADMIN.email);
  return { context, page };
}

/**
 * A1: an open invoice for the company, due `dueDaysAgo` days ago, with today's dunning run.
 * Called as the platform admin.
 */
export async function forceInvoice(
  platform: Page,
  companyId: string,
  dueDaysAgo: number,
): Promise<{ id: string; number: string; totalMinor: number }> {
  return ok(
    await platform.request.post(`/api/v1/_test/subscriptions/${companyId}/invoice`, {
      data: { dueDaysAgo },
    }),
    'force a subscription invoice (assumed test control A1)',
  );
}

/**
 * A tenancy in the new agency, made while it still has full access: an owner, a one-room
 * property, a tenant and a monthly lease signed on paper and starting today.
 */
export async function tenancyIn(page: Page): Promise<{ leaseId: string; tenantName: string }> {
  const tag = unique();
  const owner = await ok<{ id: string }>(
    await page.request.post('/api/v1/owners', {
      data: { kind: 'individual', displayName: `Kojo Owner ${tag} (e2e)` },
    }),
    'add an owner',
  );
  const part = await freePropertyPart(page, 'ACC');
  const property = await ok<{ blocks: { units: { id: string }[] }[] }>(
    await page.request.post('/api/v1/properties', {
      data: {
        areaCode: 'ACC',
        propertyPart: part,
        name: `M10 rooms ${part} (e2e)`,
        propertyType: 'compound_house',
        use: 'residential',
        ownerId: owner.id,
        address: { region: 'Greater Accra' },
        units: [{ unitType: 'single_room', count: 1 }],
      },
    }),
    'create a property',
  );
  const unitId = property.blocks.flatMap((b) => b.units)[0]!.id;
  const tenantName = `Abena Tenant ${tag} (e2e)`;
  const tenant = await newTenant(page, tenantName);
  const leaseId = await recordPaperLease(page, {
    unitId,
    tenantId: tenant.id,
    tenantName,
    startDate: today(),
    months: 12,
    monthlyRentMinor: 50_000,
    signedOn: today(),
  });
  return { leaseId, tenantName };
}

/** Cash received on a lease, recorded with its photo; it waits for a second person (P06). */
export async function recordCash(
  page: Page,
  leaseId: string,
  payerName: string,
): Promise<Awaited<ReturnType<APIRequestContext['post']>>> {
  const photo = readFileSync(fixture('property-photo.jpg'));
  const slot = await ok<{ uploadId: string; url: string; fields: Record<string, string> }>(
    await page.request.post('/api/v1/payment-uploads', {
      data: { purpose: 'cash_photo', contentType: 'image/jpeg', sizeBytes: photo.length },
    }),
    'ask for a cash photo upload',
  );
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', new Blob([photo], { type: 'image/jpeg' }), 'receipt-book.jpg');
  const stored = await fetch(slot.url, { method: 'POST', body: form });
  expect(stored.ok, `upload the photo: ${stored.status}`).toBe(true);
  return page.request.post('/api/v1/cash-records', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: {
      leaseId,
      method: 'cash',
      amountMinor: 10_000,
      receivedOn: today(),
      payerName,
      photoUploadId: slot.uploadId,
    },
  });
}

/**
 * Pays every open invoice by card on the subscription page (A2): the checkout opens in a new tab,
 * where the fake provider's "Pay" completes it; the page then shows the payment as paid.
 */
export async function payByCard(
  page: Page,
  what: 'invoices' | 'annual' = 'invoices',
): Promise<void> {
  await page.goto('/settings/subscription');
  const pay = page.getByRole('form', { name: 'Pay the subscription' });
  await ready(page, 'Pay by card');
  await pay
    .getByLabel(what === 'invoices' ? /^Every open invoice/ : /^Twelve months up front/)
    .check();
  await pay.getByLabel('Card, on the payment provider’s page').check();
  await pay.getByRole('button', { name: 'Pay by card' }).click();
  const checkout = page.getByTestId('subscription-checkout');
  await expect(checkout).toBeVisible({ timeout: 30_000 });
  const [tab] = await Promise.all([page.context().waitForEvent('page'), checkout.click()]);
  await expect(tab.getByRole('heading', { name: 'Fake checkout' })).toBeVisible();
  await tab.getByRole('button', { name: 'Pay' }).click();
  await tab.close();
  await expect(page.getByText(/^Paid GH₵[\d,.]+ \(SUB-/)).toBeVisible({ timeout: 120_000 });
}

const FAKE_PROVIDERS = process.env.FAKE_PROVIDERS_URL ?? 'http://localhost:4010';

/** The payer approves a charge on their phone (A6), through the fake provider's test control. */
export async function approveCharge(reference: string): Promise<void> {
  const response = await fetch(
    `${FAKE_PROVIDERS}/payments/_test/charges/${encodeURIComponent(reference)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'success' }),
    },
  );
  expect(response.status, `approve the charge: ${await response.text()}`).toBe(200);
}

/**
 * Pays every open invoice by MoMo on the subscription page: the prompt goes to a fresh phone,
 * the fake provider approves it (A6), and the page shows the payment as paid.
 */
export async function payByMomo(page: Page): Promise<string> {
  await page.goto('/settings/subscription');
  const pay = page.getByRole('form', { name: 'Pay the subscription' });
  await ready(page, 'Pay by card');
  await pay.getByLabel(/^Every open invoice/).check();
  await pay.getByLabel('Mobile money, approved on the phone').check();
  await pay.getByLabel('MoMo number').fill(freshPhone());
  await pay.getByLabel('Network').selectOption('mtn');
  await pay.getByRole('button', { name: 'Send the MoMo prompt' }).click();
  const status = page.getByTestId('subscription-payment-status');
  await expect(status).toContainText(/reference SUB-\S+\./, { timeout: 30_000 });
  const reference = /reference (SUB-\S+)\./.exec(await status.innerText())![1]!;
  await approveCharge(reference);
  await expect(page.getByText(/^Paid GH₵[\d,.]+ \(SUB-/)).toBeVisible({ timeout: 120_000 });
  return reference;
}
