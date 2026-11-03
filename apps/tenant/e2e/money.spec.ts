import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { formatBusinessDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { approveMomoPrompt, firstInvoiceIssued, leaseBilling, ownBilling } from './money-support';
import {
  companyName,
  freshPhone,
  LANDLORD,
  MANAGER,
  newRooms,
  newTenant,
  recordPaperLease,
  signInToApp,
  staffApi,
  today,
  type Unit,
} from './tenancy-support';

// The tenant app's money screens (M4b plan 4.10): one person, on a fresh phone, rents from the
// agency (monthly) and from the self-managing landlord (the new two-yearly cycle, decision 9).
// Home shows each tenancy's balance, paid-until and next payment in that landlord's box (TL-12);
// Pay opens the links pay page, where the tenant pays by MoMo through the fake provider; the
// payment and its receipt appear under Payments and receipts; offline, the last figures show
// with when they were fetched. One sign-in, shared by the tests.
test.describe.configure({ mode: 'serial' });

const TENANT = 'Efua Pays-In-App (e2e)';
const TIME_WITH_ZONE = /\d{1,2} \w{3} \d{4}, \d{2}:\d{2} GMT \(Africa\/Accra\)/;
const AGENCY_RENT = 140_000;
const LANDLORD_RENT = 250_000;
const cedis = (minor: number) => format(money(minor));

let agency: APIRequestContext;
let landlord: APIRequestContext;
let context: BrowserContext;
let page: Page;
let agencyName: string;
let landlordName: string;
let phone: string;
let room: Unit;
let house: Unit;
let agencyLeaseId: string;
let landlordLeaseId: string;

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(240_000);
  const { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } =
    testInfo.project.use;
  context = await browser.newContext({
    baseURL,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
  });
  try {
    [agency, landlord] = await Promise.all([staffApi(MANAGER), staffApi(LANDLORD)]);
    [agencyName, landlordName] = await Promise.all([companyName(agency), companyName(landlord)]);
    phone = freshPhone();
    [room] = (await newRooms(agency, 1, { ownerReference: 'OWN-01' })) as [Unit];
    [house] = (await newRooms(landlord, 1)) as [Unit];
    const agencyTenantId = await newTenant(agency, TENANT, phone);
    const landlordTenantId = await newTenant(landlord, TENANT, phone);
    const start = today();
    agencyLeaseId = await recordPaperLease(agency, {
      unitId: room.id,
      tenantId: agencyTenantId,
      tenantName: TENANT,
      startDate: start,
      months: 12,
      monthlyRentMinor: AGENCY_RENT,
      cycle: 'monthly',
      noticeDays: 30,
    });
    landlordLeaseId = await recordPaperLease(landlord, {
      unitId: house.id,
      tenantId: landlordTenantId,
      tenantName: TENANT,
      startDate: start,
      months: 48,
      monthlyRentMinor: LANDLORD_RENT,
      cycle: 'two_yearly',
      noticeDays: 90,
    });
    await Promise.all([
      firstInvoiceIssued(agency, agencyLeaseId),
      firstInvoiceIssued(landlord, landlordLeaseId),
    ]);
    page = await context.newPage();
    await signInToApp(page, phone);
    await expect(page.getByText(`Hello, ${TENANT}`)).toBeVisible();
  } catch (error) {
    if (page)
      await testInfo.attach('tenant app', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    throw error;
  }
});

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !page) return;
  await testInfo.attach('tenant app', { body: await page.screenshot(), contentType: 'image/png' });
});

test.afterAll(async () => {
  await context?.setOffline(false);
  await context?.close();
  await agency?.dispose();
  await landlord?.dispose();
});

const groupOf = (name: string) => page.getByTestId('landlord-group').filter({ hasText: name });

test.describe('TL-01 and BC-04 the tenant app’s money screens', () => {
  test('Home shows each tenancy’s balance, paid-until and next payment, as its landlord’s ledger has them', async () => {
    const [own, other] = await Promise.all([
      leaseBilling(agency, agencyLeaseId),
      leaseBilling(landlord, landlordLeaseId),
    ]);
    expect(own.dueNowMinor).toBeGreaterThanOrEqual(AGENCY_RENT);
    const fromAgency = groupOf(agencyName);
    await expect(fromAgency.getByTestId('due-now')).toContainText(cedis(own.dueNowMinor));
    await expect(fromAgency.getByTestId('paid-until')).toContainText('No rent paid yet');
    // The next invoice as the tenant's own answer has it. A lease that starts today has none out
    // yet (invoices go out 14 days before they fall due), with eleven months still to come.
    const mine = await ownBilling(page.request, agencyLeaseId);
    await expect(fromAgency.getByTestId('next-due')).toContainText(
      mine.nextDue
        ? `${cedis(mine.nextDue.amountMinor)} on ${formatBusinessDate(mine.nextDue.dueDate)}`
        : 'The next invoice is not out yet',
    );
    if (own.paymentReference)
      await expect(fromAgency.getByTestId('payment-reference')).toContainText(own.paymentReference);

    // The two-yearly lease: named as such, with 24 months to its invoice (decision 9).
    const fromLandlord = groupOf(landlordName);
    await expect(fromLandlord).toContainText(
      `${cedis(LANDLORD_RENT)} a month, paid every two years`,
    );
    await expect(fromLandlord.getByTestId('due-now')).toContainText(
      other.dueNowMinor > 0 ? cedis(other.dueNowMinor) : 'Nothing due now',
    );
    if (other.dueNowMinor > 0) expect(other.dueNowMinor).toBe(24 * LANDLORD_RENT);
  });

  test('Pay opens the pay page; once the MoMo payment is approved, the figures update', async () => {
    test.setTimeout(150_000);
    const before = await leaseBilling(agency, agencyLeaseId);
    const fromAgency = groupOf(agencyName);
    const opened = page.waitForEvent('popup');
    await fromAgency.getByTestId('pay').click();
    const pay = await opened;
    await pay.waitForURL(/\/[a-z]+\/[A-Za-z0-9_-]{43}$/);
    await expect(pay.getByRole('heading', { level: 1 })).toHaveText(`Pay rent to ${agencyName}`);
    await expect(pay.getByLabel('Amount to pay (GH₵)')).toHaveValue(
      cedis(before.dueNowMinor).replace('GH₵', ''),
    );
    await pay.getByLabel('Telecel Cash', { exact: true }).check();
    await pay.getByLabel('MoMo number to charge').fill(`0${phone.slice(4)}`);
    await pay.getByRole('button', { name: 'Pay', exact: true }).click();
    await expect(pay.getByRole('heading', { level: 1 })).toHaveText(
      'Approve the payment on your phone',
    );
    await approveMomoPrompt(phone);
    await expect(pay.getByRole('status').filter({ hasText: 'Thank you' })).toContainText(
      `We have received ${cedis(before.dueNowMinor)}.`,
      { timeout: 45_000 },
    );
    await pay.close();

    // Headless Chromium keeps every page focused, so closing the tab hands nothing back to the
    // app. This is the focus event a browser gives the app's tab then.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(fromAgency.getByTestId('due-now')).toContainText('Nothing due now');
    await expect(fromAgency.getByTestId('paid-until')).toContainText('Paid until');
    expect((await leaseBilling(agency, agencyLeaseId)).dueNowMinor).toBe(0);
  });

  test('Payments and receipts lists the payment with its receipt, which downloads', async () => {
    test.setTimeout(90_000);
    await page.getByTestId('open-payments').click();
    const fromAgency = page.getByTestId('landlord-payments').filter({ hasText: agencyName });
    const row = fromAgency.getByTestId('payment-row').first();
    await expect(row).toContainText(/Mobile money/);
    await expect(row).toContainText(room.code);
    // The receipt is issued by a job just after the payment posts.
    await expect(async () => {
      await page.getByTestId('refresh').click();
      await expect(row.getByTestId('receipt-number')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });

    // Its PDF is rendered by another job: until then the app says it is not ready, and the
    // tenant taps again.
    let url = '';
    await expect(async () => {
      const link = page.waitForResponse((r) =>
        /^\/me\/receipts\/[^/]+\/download$/.test(new URL(r.url()).pathname),
      );
      const opened = page.waitForEvent('popup');
      await row.getByTestId('download-receipt').click();
      const tab = await opened;
      const answer = await link;
      if (!tab.isClosed()) await tab.close();
      expect(answer.status(), 'the receipt PDF is ready').toBe(200);
      url = ((await answer.json()) as { url: string }).url;
    }).toPass({ intervals: [2_000], timeout: 60_000 });
    const receipt = await page.request.get(url);
    expect(receipt.status()).toBe(200);
    expect(receipt.headers()['content-type']).toContain('application/pdf');
    // Nothing from the other landlord in this box.
    await expect(fromAgency).not.toContainText(house.code);
    await expect(fromAgency).not.toContainText(landlordName);
    await page.getByTestId('back').click();
  });

  test('offline, the last figures show with the time they were fetched', async () => {
    await expect(groupOf(agencyName).getByTestId('due-now')).toContainText('Nothing due now');
    await context.setOffline(true);
    try {
      const fromAgency = groupOf(agencyName);
      // Coming back to the app reloads Home, one request at a time. A reload already under way
      // when the connection went (Back from Payments starts some, and on a slow runner they are
      // still out) finishes with fresh figures, as the browser lets it; so the person may come
      // back again before the app finds itself offline. Each try is one more return.
      await expect(async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(fromAgency.getByTestId('money-as-of')).toContainText(TIME_WITH_ZONE, {
          timeout: 2_000,
        });
      }).toPass({ timeout: 30_000 });
      await expect(fromAgency.getByTestId('money-as-of')).toContainText('may be out of date');
      await expect(fromAgency.getByTestId('due-now')).toContainText('Nothing due now');
      await expect(fromAgency.getByTestId('pay')).toHaveCount(0);
      // Nothing cached holds a link or a token: the app's own cache, in the browser's storage.
      const stored = await page.evaluate(() =>
        JSON.stringify(
          Object.entries(window.localStorage).filter(([key]) => key.startsWith('rent.cache.')),
        ),
      );
      expect(stored).toContain(room.code);
      expect(stored).not.toMatch(/:\/\/|\/[lp]\/[A-Za-z0-9_-]{43}/);
    } finally {
      await context.setOffline(false);
    }
    // Back online, the same: a return reloads once nothing is still under way.
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(groupOf(agencyName).getByTestId('money-as-of')).toHaveCount(0, {
        timeout: 2_000,
      });
    }).toPass({ timeout: 30_000 });
  });
});

test.describe('TL-12 one landlord never sees another landlord’s money', () => {
  test('each landlord’s figures, reference and Pay stay in that landlord’s box', async () => {
    const [own, other] = await Promise.all([
      leaseBilling(agency, agencyLeaseId),
      leaseBilling(landlord, landlordLeaseId),
    ]);
    const fromAgency = groupOf(agencyName);
    const fromLandlord = groupOf(landlordName);
    await expect(fromAgency.getByTestId('tenancy-money')).toHaveCount(1);
    await expect(fromLandlord.getByTestId('tenancy-money')).toHaveCount(1);
    await expect(fromAgency).not.toContainText(house.code);
    await expect(fromLandlord).not.toContainText(room.code);
    if (other.paymentReference) await expect(fromAgency).not.toContainText(other.paymentReference);
    if (own.paymentReference) await expect(fromLandlord).not.toContainText(own.paymentReference);
    // The landlord can see neither the agency's lease nor its money, and the other way round.
    expect((await landlord.get(`/leases/${agencyLeaseId}/billing`)).status()).toBe(404);
    expect((await agency.get(`/leases/${landlordLeaseId}/billing`)).status()).toBe(404);
  });
});
