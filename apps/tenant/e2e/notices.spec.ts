import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { NOTICE_SIGNING_STATEMENT } from '@rent/domain/esign';
import {
  companyName,
  freshPhone,
  LANDLORD,
  MANAGER,
  newRooms,
  newTenant,
  ok,
  recordPaperLease,
  signInToApp,
  staffApi,
  today,
  type Unit,
} from './tenancy-support';

// Notices in the tenant app (M7 plan 4.10; LN-02, LN-04, TL-12), on the Expo web build. One
// person, on a fresh phone, rents from the agency and from the self-managing landlord. The agency
// issues a notice of entry on its lease: the app lists it under To sign, as a notice to
// acknowledge, and among that tenancy's documents, and never under the other landlord's tenancy.
// Needs pnpm db:seed (the agency on Growth) and the running stack with the worker, which freezes
// the notice's PDF before it opens for signing. One sign-in, shared by the tests.
test.describe.configure({ mode: 'serial' });

const TENANT = 'Yaw Gets-A-Notice (e2e)';

interface NoticeDetail {
  readonly id: string;
  readonly number: string | null;
}

let agency: APIRequestContext;
let landlord: APIRequestContext;
let context: BrowserContext;
let page: Page;
let agencyName: string;
let agencyLeaseId: string;
let landlordLeaseId: string;
let notice: NoticeDetail;

const inDays = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

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
  [agency, landlord] = await Promise.all([staffApi(MANAGER), staffApi(LANDLORD)]);
  agencyName = await companyName(agency);
  const phone = freshPhone();
  const [room] = (await newRooms(agency, 1, { ownerReference: 'OWN-01' })) as [Unit];
  const [house] = (await newRooms(landlord, 1)) as [Unit];
  const agencyTenantId = await newTenant(agency, TENANT, phone);
  const landlordTenantId = await newTenant(landlord, TENANT, phone);
  const start = today();
  agencyLeaseId = await recordPaperLease(agency, {
    unitId: room.id,
    tenantId: agencyTenantId,
    tenantName: TENANT,
    startDate: start,
    months: 12,
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
  });
  landlordLeaseId = await recordPaperLease(landlord, {
    unitId: house.id,
    tenantId: landlordTenantId,
    tenantName: TENANT,
    startDate: start,
    months: 12,
    monthlyRentMinor: 200_000,
    cycle: 'monthly',
    noticeDays: 30,
  });
  const draft = await ok<NoticeDetail>(
    await agency.post('/notices', {
      data: {
        type: 'entry',
        subtype: 'inspection',
        leaseId: agencyLeaseId,
        fields: { entryDate: inDays(10), windowFrom: '10:00', windowTo: '12:00' },
      },
    }),
    'draft a notice of entry',
  );
  notice = await ok<NoticeDetail>(
    await agency.post(`/notices/${draft.id}/issue`, { data: {} }),
    'issue it',
  );
  expect(notice.number).toMatch(/^N-\d{6}$/);
  page = await context.newPage();
  await signInToApp(page, phone);
  await expect(page.getByText(`Hello, ${TENANT}`)).toBeVisible();
});

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !page) return;
  await testInfo.attach('tenant app', { body: await page.screenshot(), contentType: 'image/png' });
});

test.afterAll(async () => {
  await context?.close();
  await agency?.dispose();
  await landlord?.dispose();
});

test.describe('LN-04 notices in the tenant app', () => {
  test('lists the notice under To sign, as a notice to acknowledge', async () => {
    // The notice opens for signing once the worker has frozen its PDF.
    await expect
      .poll(
        async () => {
          await page.goto('/home');
          return page
            .getByTestId('to-sign-entry')
            .textContent({ timeout: 5_000 })
            .catch(() => '');
        },
        { message: 'the notice reaches To sign', timeout: 60_000 },
      )
      .toMatch(/1 notice is waiting for you to acknowledge receipt\./);
    await page.getByTestId('open-to-sign').click();
    const item = page.getByTestId('notice-item');
    await expect(item).toHaveCount(1);
    await expect(item.getByText(`Notice ${notice.number}: Notice of entry`)).toBeVisible();
    await expect(item.getByText(`From ${agencyName}`)).toBeVisible();
    await expect(item.getByTestId('notice-statement')).toHaveText(NOTICE_SIGNING_STATEMENT);
    await expect(item.getByTestId('own-status')).toContainText('Waiting for you to acknowledge it');
    await expect(item.getByTestId('acknowledge-notice')).toBeVisible();
    await expect(item.getByText(/decline/i)).toHaveCount(0);
  });

  test('shows the notice among the tenancy’s documents, and never under the other landlord', async () => {
    await page.goto(`/tenancy/${agencyLeaseId}`);
    const card = page.getByTestId('tenancy-notices');
    await expect(card).toBeVisible();
    const row = card.getByTestId('notice-row').filter({ hasText: `Notice ${notice.number}` });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('notice-state')).toHaveText('Waiting for you to acknowledge it');
    await expect(row.getByTestId('download-notice')).toBeVisible();
    await expect(row.getByTestId('acknowledge-notice')).toBeVisible();

    // TL-12: the self-managing landlord's tenancy shows none of the agency's notices.
    await page.goto(`/tenancy/${landlordLeaseId}`);
    await expect(page.getByTestId('tenancy-detail')).toBeVisible();
    await expect(page.getByTestId('tenancy-notices')).toHaveCount(0);
    await expect(page.getByText(`Notice ${notice.number}`)).toHaveCount(0);
  });
  test('TL-12: once /me/notices has answered with the agency’s notice, the other landlord’s tenancy still shows none (M7 review, LT 5)', async () => {
    const answered = page.waitForResponse(
      (response) =>
        /\/me\/notices(\?|$)/.test(
          new URL(response.url()).pathname + new URL(response.url()).search,
        ) && response.request().method() === 'GET',
    );
    await page.goto(`/tenancy/${landlordLeaseId}`);
    const response = await answered;
    expect(response.status()).toBe(200);
    const groups = (await response.json()) as {
      landlord: { name: string };
      notices: { number: string }[];
    }[];
    // The answer holds the agency's notice, so the screen had it to leave out.
    expect(
      groups.some(
        (group) =>
          group.landlord.name === agencyName &&
          group.notices.some((item) => item.number === notice.number),
      ),
    ).toBe(true);
    await expect(page.getByTestId('tenancy-detail')).toBeVisible();
    await expect(page.getByTestId('tenancy-notices')).toHaveCount(0);
    await expect(page.getByText(`Notice ${notice.number}`)).toHaveCount(0);
  });
});
