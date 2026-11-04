import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
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

// Messages in the tenant app (CM-05; M6 plan 4.10), on the Expo web build. One person, on a fresh
// phone, rents from the agency and from the self-managing landlord, writes to the agency, and
// reads the agency's reply. A message written offline shows Not sent, and Try again sends it once.
// Each landlord sees only their own conversation (TL-12). Needs pnpm db:seed and the running
// stack. One sign-in, shared by the tests.
test.describe.configure({ mode: 'serial' });

const TENANT = 'Akosua Writes-In (e2e)';
const QUESTION = `Is the water back on? (e2e ${Date.now()})`;
const REPLY = `Yes, since 9 this morning. (e2e ${Date.now()})`;
const OFFLINE = `Written on the bus, offline. (e2e ${Date.now()})`;
const WITH_PHOTO = `A photo of the leak. (e2e ${Date.now()})`;
/** Node's Buffer, which Playwright's file payloads need; the app's TypeScript has no Node types. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): never } }).Buffer;
/** A 1-by-1 PNG. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

interface StaffMessage {
  readonly body: string;
  readonly direction: string;
  readonly channel: string | null;
  readonly attachmentCount: number;
}

let agency: APIRequestContext;
let landlord: APIRequestContext;
let context: BrowserContext;
let page: Page;
let agencyName: string;
let landlordName: string;
let agencyTenantId: string;
let landlordTenantId: string;

/** The tenant's messages as the landlord's staff see them, newest first (CM-05). */
async function staffThread(api: APIRequestContext, tenantId: string): Promise<StaffMessage[]> {
  const { conversation } = await ok<{ conversation: { id: string } | null }>(
    await api.get(`/tenants/${tenantId}/conversation`),
    'the tenant’s conversation',
  );
  if (!conversation) return [];
  const page = await ok<{ items: StaffMessage[] }>(
    await api.get(`/conversations/${conversation.id}/messages?limit=100`),
    'the conversation’s messages',
  );
  return page.items;
}

const copiesOf = (messages: readonly StaffMessage[], body: string) =>
  messages.filter((m) => m.body === body).length;

/** How many of the tenant's timeline events carry this message (CM-05; on every plan). */
async function timelineCopies(api: APIRequestContext, tenantId: string, body: string) {
  const events = await ok<{ action: string; data: { preview?: unknown } | null }[]>(
    await api.get(`/tenants/${tenantId}/timeline`),
    'the tenant’s timeline',
  );
  return events.filter(
    (event) => event.action.startsWith('message.') && event.data?.preview === body,
  ).length;
}

async function openAgencyThread(): Promise<void> {
  await page.goto('/messages');
  const row = page.getByTestId('conversation-row').filter({ hasText: agencyName });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('thread-title')).toHaveText(agencyName);
}

async function write(text: string): Promise<void> {
  await page.getByTestId('message-input').fill(text);
  await page.getByTestId('send').click();
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
  [agency, landlord] = await Promise.all([staffApi(MANAGER), staffApi(LANDLORD)]);
  [agencyName, landlordName] = await Promise.all([companyName(agency), companyName(landlord)]);
  const phone = freshPhone();
  const [room] = (await newRooms(agency, 1, { ownerReference: 'OWN-01' })) as [Unit];
  const [house] = (await newRooms(landlord, 1)) as [Unit];
  agencyTenantId = await newTenant(agency, TENANT, phone);
  landlordTenantId = await newTenant(landlord, TENANT, phone);
  const start = today();
  await recordPaperLease(agency, {
    unitId: room.id,
    tenantId: agencyTenantId,
    tenantName: TENANT,
    startDate: start,
    months: 12,
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
  });
  await recordPaperLease(landlord, {
    unitId: house.id,
    tenantId: landlordTenantId,
    tenantName: TENANT,
    startDate: start,
    months: 12,
    monthlyRentMinor: 200_000,
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
  await context?.setOffline(false);
  await context?.close();
  await agency?.dispose();
  await landlord?.dispose();
});

test.describe('CM-05 tenant app messages', () => {
  test('one conversation with each landlord; a message reaches only the landlord it was written to', async () => {
    await page.getByTestId('open-messages').click();
    await expect(page.getByTestId('conversation-row')).toHaveCount(2);
    await expect(
      page.getByTestId('conversation-row').filter({ hasText: landlordName }),
    ).toBeVisible();
    await openAgencyThread();
    await write(QUESTION);
    const mine = page.getByTestId('own-message').filter({ hasText: QUESTION });
    await expect(mine).toBeVisible();
    await expect(mine.getByTestId('delivery')).toHaveText('Sent');
    await expect(page.getByTestId('pending-message')).toHaveCount(0);

    await expect
      .poll(async () => copiesOf(await staffThread(agency, agencyTenantId), QUESTION), {
        message: 'the agency’s inbox has the message once',
      })
      .toBe(1);
    const received = (await staffThread(agency, agencyTenantId)).find((m) => m.body === QUESTION);
    expect(received).toMatchObject({ direction: 'inbound', channel: 'in_app' });
    // TL-12: the other landlord never sees it. The self-managing landlord is on Starter, which has
    // no inbox (decision 9), so this reads each landlord's tenant timeline, which shows messages on
    // every plan: the agency's has it (the timeline works), the landlord's does not.
    await expect
      .poll(async () => timelineCopies(agency, agencyTenantId, QUESTION), {
        message: 'the agency’s timeline shows the message',
      })
      .toBe(1);
    expect(await timelineCopies(landlord, landlordTenantId, QUESTION)).toBe(0);
  });

  test('the landlord’s reply is marked new, then shows in the thread', async () => {
    const { conversation } = await ok<{ conversation: { id: string } }>(
      await agency.get(`/tenants/${agencyTenantId}/conversation`),
      'the tenant’s conversation',
    );
    await ok(
      await agency.post(`/conversations/${conversation.id}/replies`, {
        data: { clientMessageId: crypto.randomUUID(), channel: 'in_app', body: REPLY },
      }),
      'reply in the app',
    );
    await page.goto('/home');
    await expect(page.getByTestId('new-messages')).toBeVisible();
    await page.getByTestId('open-messages').click();
    const row = page.getByTestId('conversation-row').filter({ hasText: agencyName });
    await expect(row.getByTestId('unread')).toHaveText('1 new');
    await expect(
      page.getByTestId('conversation-row').filter({ hasText: landlordName }).getByTestId('unread'),
    ).toHaveCount(0);
    await row.click();
    await expect(page.getByTestId('landlord-message').filter({ hasText: REPLY })).toBeVisible();
    // Opening the thread marks the reply read.
    await page.goto('/messages');
    await expect(
      page.getByTestId('conversation-row').filter({ hasText: agencyName }).getByTestId('unread'),
    ).toHaveCount(0);
  });

  test('a message written offline shows Not sent, and Try again sends it once', async () => {
    await openAgencyThread();
    await context.setOffline(true);
    await write(OFFLINE);
    const pending = page.getByTestId('pending-message').filter({ hasText: OFFLINE });
    await expect(pending.getByTestId('delivery')).toHaveText(/^Not sent\./);
    await context.setOffline(false);
    await pending.getByTestId('retry-send').click();
    const mine = page.getByTestId('own-message').filter({ hasText: OFFLINE });
    await expect(mine.getByTestId('delivery')).toHaveText('Sent');
    await expect(page.getByTestId('pending-message')).toHaveCount(0);
    await expect
      .poll(async () => copiesOf(await staffThread(agency, agencyTenantId), OFFLINE))
      .toBe(1);
  });

  test('a photo goes to storage first, then arrives with the message', async () => {
    await openAgencyThread();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('add-photo').click();
    await (
      await chooser
    ).setFiles({ name: 'leak.png', mimeType: 'image/png', buffer: NodeBuffer.from(PNG) });
    await expect(page.getByTestId('photo-chip')).toHaveText(/^Photo 1 \(1 KB\)/);
    await write(WITH_PHOTO);
    const mine = page.getByTestId('own-message').filter({ hasText: WITH_PHOTO });
    await expect(mine.getByTestId('delivery')).toHaveText('Sent');
    await expect
      .poll(async () =>
        (await staffThread(agency, agencyTenantId)).find((m) => m.body === WITH_PHOTO),
      )
      .toMatchObject({ attachmentCount: 1 });
  });
});
