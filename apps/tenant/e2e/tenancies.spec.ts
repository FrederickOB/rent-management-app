import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { formatBusinessDate } from '@rent/domain/dates';
import {
  companyName,
  freshPhone,
  handoverLink,
  issueLease,
  LANDLORD,
  MANAGER,
  monthsAfter,
  monthsFromToday,
  newRooms,
  newTenant,
  ok,
  recordPaperLease,
  sha256Hex,
  signingCodeEmailedTo,
  signingCodeTo,
  signInToApp,
  signOnLinksPage,
  smsTo,
  staffApi,
  termEnd,
  type IssuedLease,
  type Unit,
} from './tenancy-support';

// One person, on a fresh phone, rents from the agency and from the self-managing landlord
// (TL-01), and has a second agency lease out for e-signing (TL-07). They sign in to the app once
// and the tests share the page: the API sends at most 10 sign-in codes an hour to one address.
test.describe.configure({ mode: 'serial' });

const TENANT = 'Abena Two-Landlords (e2e)';
const TIME_WITH_ZONE = /\d{1,2} \w{3} \d{4}, \d{2}:\d{2} GMT \(Africa\/Accra\)/;

let agency: APIRequestContext;
let landlord: APIRequestContext;
let context: BrowserContext;
let page: Page;
let agencyName: string;
let landlordName: string;
let phone: string;
let witnessPhone: string;
let agencyTenantId: string;
let landlordTenantId: string;
/** The agency's rooms: the first on paper, the second out for e-signing. */
let rooms: Unit[];
let house: Unit;
let paperStart: string;
let issued: IssuedLease;

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(240_000);
  // The project's device and base URL, for a page the tests share.
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
  // The config's trace setting covers this context too.
  try {
    [agency, landlord] = await Promise.all([staffApi(MANAGER), staffApi(LANDLORD)]);
    [agencyName, landlordName] = await Promise.all([companyName(agency), companyName(landlord)]);
    phone = freshPhone();
    witnessPhone = freshPhone();
    rooms = await newRooms(agency, 2, { ownerReference: 'OWN-01' });
    [house] = (await newRooms(landlord, 1)) as [Unit];
    agencyTenantId = await newTenant(agency, TENANT, phone);
    landlordTenantId = await newTenant(landlord, TENANT, phone);

    paperStart = monthsFromToday(-1);
    await recordPaperLease(agency, {
      unitId: rooms[0]!.id,
      tenantId: agencyTenantId,
      tenantName: TENANT,
      startDate: paperStart,
      months: 12,
      monthlyRentMinor: 150_000,
      cycle: 'monthly',
      depositMinor: 300_000,
      serviceChargeMonthlyMinor: 20_050,
      steps: [{ effectiveFrom: monthsAfter(paperStart, 6), monthlyRentMinor: 165_000 }],
      noticeDays: 60,
    });
    await recordPaperLease(landlord, {
      unitId: house.id,
      tenantId: landlordTenantId,
      tenantName: TENANT,
      startDate: monthsFromToday(-2),
      months: 24,
      monthlyRentMinor: 320_000,
      cycle: 'quarterly',
      noticeDays: 90,
    });
    issued = await issueLease(agency, {
      unitId: rooms[1]!.id,
      tenantId: agencyTenantId,
      witnessPhone,
      startDate: monthsFromToday(1),
      monthlyRentMinor: 90_000,
    });
    // The worker texts the tenant a signing link once the request opens. Waiting for it means the
    // link the app asks for later is the newest, not one that the worker's send replaces.
    await expect
      .poll(async () => (await smsTo(phone)).some((m) => /\/l\/[A-Za-z0-9_-]{43}/.test(m.body)), {
        message: 'the signing link reaches the tenant by SMS',
        timeout: 30_000,
      })
      .toBe(true);

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
  await context?.close();
  await agency?.dispose();
  await landlord?.dispose();
});

const groups = () => page.getByTestId('landlord-group');
const groupOf = (name: string) => groups().filter({ hasText: name });

test.describe('TL-01 tenancies by landlord', () => {
  test('one person sees each landlord’s tenancies under that landlord', async () => {
    await expect(groups()).toHaveCount(2);
    const fromAgency = groupOf(agencyName);
    const fromLandlord = groupOf(landlordName);
    await expect(fromAgency).toHaveCount(1);
    await expect(fromLandlord).toHaveCount(1);
    await expect(fromAgency.getByTestId('tenancy-card')).toHaveCount(2);
    await expect(
      fromAgency.getByTestId('tenancy-card').filter({ hasText: rooms[0]!.code }),
    ).toContainText('GH₵1,500.00 a month, paid monthly');
    await expect(
      fromAgency.getByTestId('tenancy-card').filter({ hasText: rooms[1]!.code }),
    ).toContainText('Waiting for signatures');
    await expect(fromLandlord.getByTestId('tenancy-card')).toHaveCount(1);
    await expect(fromLandlord.getByTestId('tenancy-card')).toContainText(house.code);
    await expect(fromLandlord.getByTestId('tenancy-card')).toContainText(
      'GH₵3,200.00 a month, paid quarterly',
    );
  });

  test('opens a tenancy with its terms and downloads the signed copy', async () => {
    await groupOf(agencyName)
      .getByTestId('tenancy-card')
      .filter({ hasText: rooms[0]!.code })
      .click();
    await expect(page.getByTestId('tenancy-detail')).toBeVisible();
    await expect(page.getByRole('heading', { name: rooms[0]!.code })).toBeVisible();
    await expect(page.getByTestId('tenancy-status')).toHaveText('Active');
    await expect(page.getByTestId('landlord-name')).toHaveText(`Rented from ${agencyName}`);
    await expect(page.getByTestId('fact-dates')).toContainText(
      `${formatBusinessDate(paperStart)} to ${formatBusinessDate(termEnd(paperStart, 12))}`,
    );
    await expect(page.getByTestId('fact-rent')).toContainText('GH₵1,500.00 a month, paid monthly');
    await expect(page.getByTestId('fact-steps')).toContainText(
      `From ${formatBusinessDate(monthsAfter(paperStart, 6))}: GH₵1,650.00 a month`,
    );
    await expect(page.getByTestId('fact-deposit')).toContainText('GH₵3,000.00');
    await expect(page.getByTestId('fact-service-charge')).toContainText('GH₵200.50 a month');
    await expect(page.getByTestId('fact-notice')).toContainText('60 days');
    await expect(page.getByTestId('signed-how')).toHaveText('Signed on paper.');

    // A fresh 5-minute link to the scan, opened in a tab of its own.
    const requested: string[] = [];
    const record = (request: { url(): string }) => requested.push(request.url().split('?')[0]!);
    context.on('request', record);
    const link = page.waitForResponse((r) =>
      /^\/me\/documents\/[^/]+\/download$/.test(new URL(r.url()).pathname),
    );
    const opened = page.waitForEvent('popup');
    await page.getByTestId('download-signed').click();
    const tab = await opened;
    const { url } = (await (await link).json()) as { url: string };
    await expect
      .poll(() => requested.includes(url.split('?')[0]!), {
        message: 'the new tab goes to the signed copy',
      })
      .toBe(true);
    context.off('request', record);
    const copy = await page.request.get(url);
    expect(copy.status()).toBe(200);
    expect(copy.headers()['content-type']).toContain('application/pdf');
    expect(new TextDecoder().decode((await copy.body()).subarray(0, 5))).toBe('%PDF-');
    await tab.close();

    await page.getByTestId('back').click();
    await expect(groups()).toHaveCount(2);
  });
});

test.describe('TL-12 one landlord never sees another landlord’s tenancy', () => {
  test('each landlord’s tenancies stay in a box of their own, and in the API too', async () => {
    const fromAgency = groupOf(agencyName);
    const fromLandlord = groupOf(landlordName);
    await expect(fromAgency).toContainText(rooms[0]!.code);
    await expect(fromAgency).not.toContainText(house.code);
    await expect(fromAgency).not.toContainText(landlordName);
    await expect(fromLandlord).toContainText(house.code);
    await expect(fromLandlord).not.toContainText(rooms[0]!.code);
    await expect(fromLandlord).not.toContainText(rooms[1]!.code);
    await expect(fromLandlord).not.toContainText(agencyName);

    // Staff in each company see only their own lease for the same person.
    const units = async (api: APIRequestContext, tenantId: string) =>
      (
        await ok<{ leases: { unitCode: string }[] }>(
          await api.get(`/tenants/${tenantId}`),
          'the tenant',
        )
      ).leases
        .map((l) => l.unitCode)
        .sort();
    expect(await units(agency, agencyTenantId)).toEqual([rooms[0]!.code, rooms[1]!.code].sort());
    expect(await units(landlord, landlordTenantId)).toEqual([house.code]);
    expect((await agency.get(`/tenants/${landlordTenantId}`)).status()).toBe(404);
    expect((await landlord.get(`/tenants/${agencyTenantId}`)).status()).toBe(404);
  });
});

test.describe('TL-07 to sign', () => {
  test('the tenant opens the lease from To sign and signs it on the signing page', async () => {
    test.setTimeout(120_000);
    const entry = page.getByTestId('to-sign-entry');
    await expect(entry).toContainText('1 lease is waiting for your signature.');
    await entry.getByTestId('open-to-sign').click();

    const item = page.getByTestId('signing-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(`From ${agencyName}`);
    await expect(item).toContainText(rooms[1]!.code);
    await expect(item).toContainText(TIME_WITH_ZONE);
    await expect(item.getByTestId('own-status')).toContainText('Waiting for your signature');
    const others = item.getByTestId('other-signers');
    await expect(others).toContainText(MANAGER.name);
    await expect(others).toContainText('Esi Witness (e2e)');
    await expect(others).not.toContainText(TENANT);

    // The tab opens in the tap and goes to the fresh link once the app has it.
    const opened = page.waitForEvent('popup');
    await item.getByTestId('review-and-sign').click();
    const signing = await opened;
    await signing.waitForURL(/\/l\/[A-Za-z0-9_-]{43}$/);
    await expect(signing.getByRole('heading', { level: 1 })).toBeVisible();
    await signOnLinksPage(signing, TENANT, (after) => signingCodeTo(phone, after));
    await signing.close();

    // Headless Chromium keeps every page focused and visible, so closing the signing tab hands
    // nothing back to the app. This is the focus event a browser gives the app's tab then.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(item.getByTestId('own-status')).toContainText('You have signed');
    await expect(item.getByTestId('own-status')).toContainText(TIME_WITH_ZONE);
    await expect(item.getByTestId('review-and-sign')).toHaveCount(0);
    const progress = await ok<{ signers: { role: string; status: string }[] }>(
      await agency.get(`/leases/${issued.leaseId}/signing`),
      'signing progress',
    );
    expect(Object.fromEntries(progress.signers.map((s) => [s.role, s.status]))).toMatchObject({
      tenant: 'signed',
      landlord: 'pending',
      witness: 'pending',
    });
  });

  test('once everyone has signed, the lease is signed in the app with its signed copy', async () => {
    test.setTimeout(180_000);
    // Staff hand the witness and the landlord's signer their links (decision 2).
    const signer = await context.newPage();
    await signer.goto(await handoverLink(agency, issued, 'witness'));
    await signOnLinksPage(signer, 'Esi Witness (e2e)', (after) =>
      signingCodeTo(witnessPhone, after),
    );
    await signer.goto(await handoverLink(agency, issued, 'landlord'));
    await signOnLinksPage(signer, MANAGER.name, (after) =>
      signingCodeEmailedTo(MANAGER.email, after),
    );
    await signer.close();
    await expect
      .poll(
        async () =>
          (await ok<{ status: string }>(await agency.get(`/leases/${issued.leaseId}`), 'lease'))
            .status,
        { message: 'the worker finalises and the lease is signed', timeout: 90_000 },
      )
      .toBe('signed');

    // Back on Home, which reloads as it comes into view: nothing left to sign.
    await page.getByTestId('back').click();
    await expect(page.getByTestId('to-sign-entry')).toHaveCount(0);
    const card = groupOf(agencyName)
      .getByTestId('tenancy-card')
      .filter({ hasText: rooms[1]!.code });
    await expect(card).toContainText('Signed');
    await card.click();
    await expect(page.getByTestId('signed-how')).toHaveText('Signed electronically.');

    // The download is the signed copy, certificate and all.
    const { finalSha256 } = await ok<{ finalSha256: string }>(
      await agency.get(`/leases/${issued.leaseId}/signing`),
      'signing progress',
    );
    const link = page.waitForResponse((r) =>
      /^\/me\/documents\/[^/]+\/download$/.test(new URL(r.url()).pathname),
    );
    const opened = page.waitForEvent('popup');
    await page.getByTestId('download-signed').click();
    const tab = await opened;
    const { url } = (await (await link).json()) as { url: string };
    const copy = await page.request.get(url);
    expect(copy.status()).toBe(200);
    expect(await sha256Hex(await copy.body())).toBe(finalSha256);
    await tab.close();
  });
});
