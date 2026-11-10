import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { payByMomo, payLink, type PayLink } from '../e2e/page-fixtures';
import { managerApi, smsTo } from '../e2e/signing-support';
import {
  LINKS_URL,
  measure,
  openBrowser,
  record,
  TENANT_URL,
  type Measured,
  type MeasuringBrowser,
} from './collect';

// NFR-PERF (M11 decision 8): the tenant web app's sign-in, home, pay, history and receipt
// screens over 3G with a slow CPU. The first visit downloads the app itself, so its budget is the
// size (under 1 MB) and its largest paint is recorded; on a repeat visit, with the app cached,
// the largest paint is under 3 s. Layout shift is under 0.1 on both. The tenant signs in through
// the fake one-time code, as a tenant would. Asserted by `lhci assert` (run.mjs).
//
// The pay screen is Home, where each tenancy shows what is due and its Pay button (the pay page
// itself is a links page); the tenancy's own page is measured too. History and receipts are the
// payments screen. A receipt opens as a links page or a PDF, both measured with the links pages.
test.describe.configure({ mode: 'serial' });

let staff: APIRequestContext;
let browser: MeasuringBrowser;
let tenant: PayLink;

/** The newest sign-in code sent to a phone since `after`, from the fake SMS provider. */
async function signInCode(phone: string, after: number): Promise<string> {
  let code = '';
  await expect
    .poll(
      async () => {
        const message = (await smsTo(phone)).find(
          (m) => /sign-in code is \d{6}/.test(m.body) && Date.parse(m.at) >= after - 1_000,
        );
        code = (message && /\b(\d{6})\b/.exec(message.body)?.[1]) ?? '';
        return code !== '';
      },
      { message: 'the sign-in code reaches the fake SMS provider', timeout: 30_000 },
    )
    .toBe(true);
  return code;
}

/** Signs in to the tenant web app by phone, as a tenant does. */
async function signIn(page: Page, phone: string): Promise<void> {
  const started = Date.now();
  await page.goto(`${TENANT_URL}/`);
  await page.getByTestId('phone-input').fill(`0${phone.slice(4)}`);
  await page.getByTestId('send-code').click();
  await page.getByTestId('code-input').fill(await signInCode(phone, started));
  await page.getByTestId('verify-code').click();
  await expect(page.getByTestId('open-payments')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  staff = await managerApi();
  browser = await openBrowser(LINKS_URL);
  // A tenant with a lease and one payment, so history and receipts have something to show.
  tenant = await payLink(staff, 'Akua Measures-App (e2e)');
  await payByMomo(await browser.page(), tenant);
});

test.afterAll(async () => {
  await browser?.close();
  await staff?.dispose();
});

test('NFR-PERF AD-06 TL-01 BC-04 BC-06 the tenant web app on a first and a repeat visit over 3G', async () => {
  const measured: Measured[] = [];
  const twice = async (name: string, path: string, signedIn: boolean) => {
    const url = `${TENANT_URL}${path}`;
    measured.push(
      await measure(browser, {
        group: 'tenant-first',
        name,
        url,
        firstVisit: true,
        keepStorage: signedIn,
      }),
    );
    measured.push(
      await measure(browser, {
        group: 'tenant-repeat',
        name,
        url,
        firstVisit: false,
        keepStorage: true,
      }),
    );
  };

  await twice('sign-in', '/', false);
  await signIn(await browser.page(), tenant.lease.tenantPhone);
  await twice('home and pay', '/home', true);
  await twice('tenancy', `/tenancy/${tenant.lease.leaseId}`, true);
  await twice('history and receipts', '/payments', true);
  record(measured);
});
