import { AxeBuilder } from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  freshPhone,
  MANAGER,
  newRooms,
  newTenant,
  ok,
  recordPaperLease,
  signInCodeTo,
  staffApi,
  today,
  type Unit,
} from './tenancy-support';

// NFR-A11Y (M11 plan 4.9): axe's WCAG 2.2 A and AA rules on every screen of the tenant web app, in
// its main states, on a 5-inch phone. A serious or critical violation fails; every violation is
// attached to the report. One tenant of the agency, signed in once. Needs pnpm db:seed and the
// running stack.
test.describe.configure({ mode: 'serial' });

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TENANT = 'Yaa Checks-Screens (e2e)';

let agency: APIRequestContext;
let context: BrowserContext;
let page: Page;
let leaseId: string;
let companyId: string;
let phone: string;

async function expectAccessible(testInfo: TestInfo, state: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  if (results.violations.length > 0)
    await testInfo.attach(`axe: ${state}`, {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join('; ')})`,
    );
  expect(blocking, `serious or critical axe violations on ${state}`).toEqual([]);
}

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
  agency = await staffApi(MANAGER);
  companyId = (await ok<{ id: string }>(await agency.get('/company'), 'the company')).id;
  phone = freshPhone();
  const [room] = (await newRooms(agency, 1, { ownerReference: 'OWN-01' })) as [Unit];
  const tenantId = await newTenant(agency, TENANT, phone);
  leaseId = await recordPaperLease(agency, {
    unitId: room.id,
    tenantId,
    tenantName: TENANT,
    startDate: today(),
    months: 12,
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
  });
  page = await context.newPage();
  // Signed out first: the sign-in screen and its refusal.
  await page.goto('/');
  await expect(page.getByTestId('phone-input')).toBeVisible();
  await page.getByTestId('send-code').click();
  await expect(page.getByTestId('error')).toBeVisible();
});

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !page) return;
  await testInfo.attach('tenant app', { body: await page.screenshot(), contentType: 'image/png' });
});

test.afterAll(async () => {
  await context?.close();
  await agency?.dispose();
});

test.describe('NFR-A11Y the tenant web app, WCAG 2.2 A and AA', () => {
  test('AD-06 sign-in: the phone step with its refusal, then the code step', async ({
    browserName: _browserName,
  }, testInfo) => {
    await expectAccessible(testInfo, 'sign-in: a refused number');
    const started = Date.now();
    await page.getByTestId('phone-input').fill(`0${phone.slice(4)}`);
    await page.getByTestId('send-code').click();
    await expect(page.getByTestId('code-input')).toBeVisible();
    await expectAccessible(testInfo, 'sign-in: the code step');
    await page.getByTestId('code-input').fill(await signInCodeTo(phone, started));
    await page.getByTestId('verify-code').click();
    await expect(page.getByText(`Hello, ${TENANT}`)).toBeVisible();
  });

  test('TL-01 BC-04 home with what is due and Pay, the tenancy, and payments', async ({
    browserName: _browserName,
  }, testInfo) => {
    await page.goto('/home');
    await expect(page.getByTestId('pay')).toBeVisible();
    await expectAccessible(testInfo, 'home, with what is due and Pay');
    await page.goto(`/tenancy/${leaseId}`);
    await expect(page.getByTestId('fact-deposit')).toBeVisible();
    await expectAccessible(testInfo, 'tenancy');
    await page.goto('/payments');
    await expect(page.getByText('Payments and receipts')).toBeVisible();
    await expectAccessible(testInfo, 'payments and receipts');
  });

  test('CM-05 messages: the list and a conversation', async ({ browserName: _b }, testInfo) => {
    await page.goto('/messages');
    await expect(page.getByTestId('conversation-row').first()).toBeVisible();
    await expectAccessible(testInfo, 'messages');
    await page.goto(`/messages/${companyId}`);
    await expect(page.getByTestId('message-input')).toBeVisible();
    await expectAccessible(testInfo, 'a conversation');
  });

  test('MI-01 MI-06 repairs: the list and a new request, with its problem shown', async ({
    browserName: _b,
  }, testInfo) => {
    await page.goto('/repairs');
    await expect(page.getByTestId('report-repair')).toBeVisible();
    await expectAccessible(testInfo, 'repairs');
    await page.getByTestId('report-repair').click();
    await expect(page.getByTestId('repair-description')).toBeVisible();
    await expectAccessible(testInfo, 'new repair');
    await page.getByTestId('send-repair').click();
    await expect(page.getByTestId('repair-problem')).toBeVisible();
    await page.getByTestId('category-plumbing').click();
    await expectAccessible(testInfo, 'new repair: a kind chosen, and a problem');
  });

  test('TL-07 to sign, and the profile', async ({ browserName: _b }, testInfo) => {
    await page.goto('/to-sign');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(testInfo, 'to sign');
    await page.goto('/profile');
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await expectAccessible(testInfo, 'profile');
  });
});
