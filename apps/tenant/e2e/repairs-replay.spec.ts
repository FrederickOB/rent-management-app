import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  freshPhone,
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

// A repair whose answer is lost (MI-01; M8 decision 3, review LT 10). The API makes the job, but
// the answer never reaches the app, as on a train going into a tunnel. The app keeps the request
// and sends it again with the same clientId; the API answers with the job it already made, so the
// agency's board has one job, and the tenant's list one repair. On the Expo web build; needs
// pnpm db:seed and the running stack.
test.describe.configure({ mode: 'serial' });

const TENANT = 'Kojo Lost-Answer (e2e)';
const DESCRIPTION = `The front door lock sticks. (e2e ${Date.now()})`;

let agency: APIRequestContext;
let context: BrowserContext;
let page: Page;
let tenantId: string;

async function jobsOnTheBoard(): Promise<{ id: string; description: string }[]> {
  const listed = await ok<{ items: { id: string; description: string }[] }>(
    await agency.get(`/maintenance-jobs?tenantId=${tenantId}&limit=100`),
    'the maintenance board',
  );
  return listed.items.filter((job) => job.description === DESCRIPTION);
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
  const phone = freshPhone();
  const [room] = (await newRooms(agency, 1, { ownerReference: 'OWN-01' })) as [Unit];
  tenantId = await newTenant(agency, TENANT, phone);
  await recordPaperLease(agency, {
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
});

test.describe('MI-01 a repair whose answer is lost is made once (review LT 10)', () => {
  test('the job is made, the answer is lost, the app sends it again with the same clientId, and there is one job', async () => {
    // The first report reaches the API, which makes the job; its answer is then cut.
    const reports: { clientId: string }[] = [];
    let cut = false;
    await page.route('**/me/repairs', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      reports.push(route.request().postDataJSON() as { clientId: string });
      if (cut) return route.continue();
      cut = true;
      await route.fetch();
      await route.abort('connectionreset');
    });

    await page.getByTestId('open-repairs').click();
    await page.getByTestId('report-repair').click();
    await page.getByTestId('category-carpentry').click();
    await page.getByTestId('repair-description').fill(DESCRIPTION);
    await page.getByTestId('send-repair').click();
    await expect(page.getByTestId('repair-waiting')).toHaveText(/saved on this phone/);
    await expect.poll(async () => (await jobsOnTheBoard()).length).toBe(1);

    // Send now: the same request again (unless the app, back in front, already sent it).
    await page.getByTestId('see-repairs').click();
    await page
      .getByTestId('queued-repair')
      .filter({ visible: true })
      .getByTestId('send-queued')
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    await expect(page.getByTestId('queued-repair')).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.getByTestId('repair-row').filter({ visible: true }).filter({ hasText: DESCRIPTION }),
    ).toHaveCount(1);

    expect(reports).toHaveLength(2);
    expect(reports[1]!.clientId).toBe(reports[0]!.clientId);
    expect(await jobsOnTheBoard()).toHaveLength(1);
    await page.unroute('**/me/repairs');
  });
});
