import { format, money } from '@rent/domain/money';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  chargesTo,
  completeCharge,
  leaseBilling,
  leaseDueToday,
  linkPathIn,
  openInvoice,
  pendingMomoCharge,
  sendPayLink,
  smsSince,
  type PayLease,
} from './pay-support';
import { managerApi } from './signing-support';
import { fakeToken, headerValues, nonceOf, policyShape } from './support';

// BC-04 and BC-06 (M4b plan 4.3; CLAUDE.md section 9): the pay page shows what is due, takes
// part payment and payment ahead by MoMo or card through the fake provider, and the receipt
// follows. Like the signing page, it stays under 1 MB, works on a 5-inch screen over 3G, sets no
// cookie and runs under a strict, nonce-based policy.
const ONE_MB = 1_000_000;
const STRICT_POLICY = {
  'default-src': ["'none'"],
  'script-src': ["'self'", "'nonce-NONCE'", "'strict-dynamic'"],
  'style-src': ["'self'", "'nonce-NONCE'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};
/** WebPageTest's 3G profile: 1.6 Mbps down, 768 kbps up, 300 ms round trips (bytes a second). */
const THREE_G = {
  offline: false,
  latency: 300,
  downloadThroughput: 209_715,
  uploadThroughput: 98_304,
};
const RENT_MINOR = 120_000;
const cedis = (minor: number) => format(money(minor));
/** The amount box's value for an amount: `1,200.00`. */
const typed = (minor: number) => cedis(minor).replace('GH₵', '');

let api: APIRequestContext;
let lease: PayLease;
let payPath: string;
/** The receipt link the ★ payment's receipt SMS carries. */
let receiptPath: string | null = null;

function meter(page: Page) {
  const transfers: Promise<number>[] = [];
  page.on('requestfinished', (request) => {
    transfers.push(
      request.sizes().then((sizes) => sizes.responseHeadersSize + sizes.responseBodySize),
    );
  });
  return { total: async () => (await Promise.all(transfers)).reduce((sum, n) => sum + n, 0) };
}

async function throttle(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', THREE_G);
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const dueNow = (page: Page) =>
  page.getByRole('region', { name: 'Due now' }).locator('.amount').innerText();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  api = await managerApi();
  lease = await leaseDueToday(api, 'Kojo Payer (e2e)', RENT_MINOR);
  const invoiceId = await openInvoice(api, lease.leaseId);
  payPath = await sendPayLink(api, invoiceId, lease.tenantPhone);
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('BC-04 pay page', () => {
  test('transfers under 1 MB and works on a 5-inch screen over a throttled 3G connection', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    expect(page.viewportSize()).toEqual({ width: 360, height: 640 });
    await throttle(page);
    const first = meter(page);
    const started = Date.now();
    await page.goto(payPath, { waitUntil: 'load' });
    const loadedIn = Date.now() - started;
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
    await expect(page.getByLabel('Amount to pay (GH₵)')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const bytes = await first.total();
    expect(bytes).toBeLessThan(ONE_MB);
    expect(loadedIn).toBeLessThan(15_000);
    await noSidewaysScroll(page);
    testInfo.annotations.push({
      type: 'page weight',
      description: `pay page ${bytes} bytes in ${loadedIn} ms on 3G`,
    });
  });

  test('sets no cookie and sends a strict nonce policy, no-referrer and no-store', async ({
    page,
    request,
  }) => {
    for (const path of [payPath, `${payPath}?step=again`]) {
      const response = await request.get(path, { headers: { cookie: 'session=elsewhere' } });
      expect(response.status(), path).toBe(200);
      const headers = response.headersArray();
      expect(headerValues(headers, 'set-cookie'), path).toEqual([]);
      const [policy = ''] = headerValues(headers, 'content-security-policy');
      expect(policyShape(policy), path).toEqual(STRICT_POLICY);
      expect(headerValues(headers, 'referrer-policy')).toEqual(['no-referrer']);
      expect(headerValues(headers, 'cache-control').join(', ')).toContain('no-store');
    }
    // A form post answers with a redirect that carries no cookie and is not stored either.
    const posted = await request.post(`${payPath}/pay`, {
      form: { amount: 'nonsense', method: 'card' },
      maxRedirects: 0,
    });
    expect(posted.status()).toBe(303);
    expect(posted.headers()['location']).toContain('error=AMOUNT_FORMAT');
    expect(headerValues(posted.headersArray(), 'set-cookie')).toEqual([]);
    expect(posted.headers()['cache-control']).toContain('no-store');

    const violations: string[] = [];
    page.on('console', (message) => {
      if (/content security policy/i.test(message.text())) violations.push(message.text());
    });
    page.on('pageerror', (error) => violations.push(error.message));
    const response = await page.goto(payPath);
    const nonce = nonceOf((await response!.allHeaders())['content-security-policy'] ?? '');
    for (const tag of (await response!.text()).match(/<(script|style)\b[^>]*>/g) ?? [])
      expect(tag).toContain(`nonce="${nonce}"`);
    await expect.poll(() => page.evaluate(() => 'next' in window)).toBe(true);
    // The page's form posts to its URL, but the token is never shown.
    const token = payPath.split('/').at(-1)!;
    expect(await page.locator('body').innerText()).not.toContain(token);
    expect(await page.title()).not.toContain(token);
    expect(violations).toEqual([]);
    expect(await page.context().cookies()).toEqual([]);
  });

  test('shows what is due, pre-filled, with the tenancy, and the range a payment may take', async ({
    page,
  }) => {
    const billing = await leaseBilling(api, lease.leaseId);
    expect(billing.dueNowMinor).toBeGreaterThanOrEqual(RENT_MINOR);
    await page.goto(payPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Pay rent to /);
    expect(await dueNow(page)).toBe(cedis(billing.dueNowMinor));
    await expect(page.getByLabel('Amount to pay (GH₵)')).toHaveValue(typed(billing.dueNowMinor));
    await expect(page.getByText(lease.unitCode)).toBeVisible();
    await expect(page.getByText(/any amount from GH₵1\.00 to GH₵[\d,]+\.\d\d/)).toBeVisible();
    for (const method of ['MTN MoMo', 'Telecel Cash', 'AT Money', 'Card'])
      await expect(page.getByLabel(method, { exact: true })).toBeVisible();

    // BC-09: the invoice itself, as a fresh 5-minute download (or back to the page if its PDF is
    // still being rendered).
    const invoice = await page.request.get(`${payPath}/invoice`, { maxRedirects: 0 });
    expect(invoice.status()).toBe(303);
    const location = invoice.headers()['location']!;
    if (location.startsWith(payPath)) expect(location).toContain('invoice=unavailable');
    else {
      const file = await page.request.get(location);
      expect(file.status()).toBe(200);
      expect(file.headers()['content-type']).toContain('application/pdf');
    }
  });

  test('refuses a payment past the rent left to the end of the term, and says why', async ({
    page,
  }) => {
    await page.goto(payPath);
    await page.getByLabel('Amount to pay (GH₵)').fill(typed(RENT_MINOR * 100));
    await page.getByLabel('Card', { exact: true }).check();
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('You can pay at most');
    // Nothing was charged, and the form keeps the choice.
    await expect(page.getByLabel('Card', { exact: true })).toBeChecked();
    await page.getByLabel('MTN MoMo', { exact: true }).check();
    await page.getByLabel('Amount to pay (GH₵)').fill('10');
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Enter the MoMo number to charge.');
  });

  test('takes part payment by card, through the provider’s checkout, and shows what is left', async ({
    page,
  }) => {
    const before = await leaseBilling(api, lease.leaseId);
    const part = 20_000;
    await page.goto(payPath);
    await page.getByLabel('Amount to pay (GH₵)').fill(typed(part));
    await page.getByLabel('Card', { exact: true }).check();
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Continue to the card payment page',
    );
    await page.getByRole('link', { name: `Continue to pay ${cedis(part)}` }).click();

    // The fake provider's checkout, standing in for Paystack's.
    await expect(page.getByRole('heading', { name: 'Fake checkout' })).toBeVisible();
    const reference = await page.locator('tr', { hasText: 'Reference' }).locator('td').innerText();
    await page.getByRole('button', { name: 'Pay' }).click();
    // Paystack sends the tenant back with the reference; the fake may not, so return as it would.
    if (!page.url().includes(payPath))
      await page.goto(`${payPath}?trxref=${reference}&reference=${reference}`);
    await expect(page.getByRole('status')).toContainText(
      `Thank you. We have received ${cedis(part)}.`,
      { timeout: 30_000 },
    );
    expect(await dueNow(page)).toBe(cedis(before.dueNowMinor - part));
    await expect(page.getByLabel('Amount to pay (GH₵)')).toHaveValue(
      typed(before.dueNowMinor - part),
    );
    expect((await leaseBilling(api, lease.leaseId)).dueNowMinor).toBe(before.dueNowMinor - part);
  });

  test('works without JavaScript', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(payPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Pay rent to /);
    await page.getByLabel('Amount to pay (GH₵)').fill('1');
    await page.getByLabel('AT Money', { exact: true }).check();
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Enter the MoMo number to charge.');
    await context.close();
  });
});

test.describe('BC-04 and BC-06 the tenant pays by MoMo and gets a receipt within a minute', () => {
  test('opens the pay link, approves the MoMo prompt, sees the balance update and gets the receipt', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const before = await leaseBilling(api, lease.leaseId);
    expect(before.dueNowMinor).toBeGreaterThan(0);
    await page.goto(payPath);
    expect(await dueNow(page)).toBe(cedis(before.dueNowMinor));
    await expect(page.getByLabel('Amount to pay (GH₵)')).toHaveValue(typed(before.dueNowMinor));
    await page.getByLabel('MTN MoMo', { exact: true }).check();
    // The number in its local form, as a tenant types it.
    await page.getByLabel('MoMo number to charge').fill(`0${lease.tenantPhone.slice(4)}`);
    const submitted = page.getByRole('button', { name: 'Pay', exact: true });
    // A double tap still makes one charge.
    await submitted.dblclick();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Approve the payment on your phone',
    );
    await expect(page.getByText(`We have asked for ${cedis(before.dueNowMinor)}.`)).toBeVisible();

    // The tenant approves on their phone.
    const charge = await pendingMomoCharge(lease.tenantPhone);
    expect(charge.amount).toBe(before.dueNowMinor);
    const approvedAt = Date.now();
    await completeCharge(charge.reference);

    // The page checks again by itself, then thanks the tenant with the receipt number.
    await expect(page.getByRole('status').filter({ hasText: 'Thank you' })).toContainText(
      `We have received ${cedis(before.dueNowMinor)}.`,
      { timeout: 45_000 },
    );
    await expect(page.getByText(/Receipt number \S+/)).toBeVisible({ timeout: 30_000 });
    const after = await leaseBilling(api, lease.leaseId);
    expect(after.dueNowMinor).toBe(0);
    expect(after.paidUntil).not.toBeNull();

    // The receipt reaches the tenant within a minute of the payment's confirmation.
    const receipt = await smsSince(lease.tenantPhone, /receipt/i, approvedAt - 1_000, 75_000);
    expect(receipt.at - approvedAt).toBeLessThan(60_000);
    receiptPath = linkPathIn(receipt.body);
    // The double tap made one charge.
    expect((await chargesTo(lease.tenantPhone)).map((tx) => tx.reference)).toEqual([
      charge.reference,
    ]);
  });
});

test.describe('BC-06 the receipt link', () => {
  test('shows the receipt and downloads its PDF, under 1 MB, with no cookie and a strict policy', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    expect(receiptPath, 'the receipt SMS carries a link to the receipt').not.toBeNull();
    const path = receiptPath!;
    const weight = meter(page);
    await page.goto(path, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your receipt');
    expect(await weight.total()).toBeLessThan(ONE_MB);
    await expect(page.getByRole('region', { name: /^Receipt \S+/ })).toContainText(lease.unitCode);
    await noSidewaysScroll(page);
    const response = await request.get(path, { headers: { cookie: 'session=elsewhere' } });
    const headers = response.headersArray();
    expect(headerValues(headers, 'set-cookie')).toEqual([]);
    expect(policyShape(headerValues(headers, 'content-security-policy')[0] ?? '')).toEqual(
      STRICT_POLICY,
    );
    expect(headerValues(headers, 'cache-control').join(', ')).toContain('no-store');

    // The PDF may still be rendering: the page looks again by itself until it can be downloaded.
    const download = page.getByRole('link', { name: 'Download the receipt (PDF)' });
    await expect(download).toBeVisible({ timeout: 60_000 });
    const pdf = await request.get(`${path}/document`, { maxRedirects: 0 });
    expect(pdf.status()).toBe(303);
    const file = await request.get(pdf.headers()['location']!);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toContain('application/pdf');
    expect((await file.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

test.describe('BC-04 a settled or unknown pay link explains itself', () => {
  test('a link whose invoice is paid takes no more payments', async ({ page }) => {
    await page.goto(payPath);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /^(This invoice is paid|Thank you: your payment is received)$/,
    );
    await expect(page.getByRole('button', { name: 'Pay', exact: true })).toHaveCount(0);
    await expect(page.getByText(/Contact /).first()).toBeVisible();
    // Posting a payment anyway starts nothing.
    const response = await page.request.post(`${payPath}/pay`, {
      form: { amount: '10', method: 'card', submissionId: 'abcdefghijklmnopqrst' },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers()['location']).toContain('error=');
  });

  test('an unknown link is not found and says nothing about any tenancy', async ({ page }) => {
    const response = await page.goto(`/p/${fakeToken()}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'This link is not valid or has expired',
    );
    await expect(page.getByText(/Nothing has been charged/)).toBeVisible();
  });
});
