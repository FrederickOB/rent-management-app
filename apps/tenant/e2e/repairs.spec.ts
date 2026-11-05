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

// Repairs in the tenant app (MI-01, MI-06, CM-04; M8 decision 3 and plan 4.11), on the Expo web
// build. A tenant of the agency (on Growth) writes a repair with a photo and a voice note while
// offline; it waits in the tab and goes once the browser is back online, as one job with both
// files, however often it is tried. The agency's staff move it through to Work done, and the
// tenant confirms the work in the app. Needs pnpm db:seed and the running stack. On the web, a
// voice note is chosen as a file (the browser cannot record a format the server takes), and the
// files of a waiting request live in the open tab, so the spec never reloads before it is sent.
test.describe.configure({ mode: 'serial' });

const TENANT = 'Yaw Reports-Repairs (e2e)';
const DESCRIPTION = `Water drips from the bathroom ceiling. (e2e ${Date.now()})`;
const COMPLETION_NOTE = 'Replaced the cracked pipe above the bathroom and sealed the joint.';
/** Node's Buffer, which Playwright's file payloads need; the app's TypeScript has no Node types. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): never } }).Buffer;
/** A 1-by-1 PNG. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

/**
 * Two seconds of silent MP3: MPEG-1 Layer III frames at 128 kbit/s, 44.1 kHz, mono, with no ID3
 * tag. The server reads the type from the first bytes (0xFF 0xFB), and the browser reads the
 * length from the frames, as it would for a voice note saved on a phone.
 */
function silentMp3(seconds: number): Uint8Array {
  const frameBytes = Math.floor((144 * 128_000) / 44_100);
  const frames = Math.ceil((seconds * 44_100) / 1152);
  const bytes = new Uint8Array(frameBytes * frames);
  for (let i = 0; i < frames; i += 1) bytes.set([0xff, 0xfb, 0x90, 0xc0], i * frameBytes);
  return bytes;
}

interface StaffJob {
  readonly id: string;
  readonly ticket: string;
  readonly status: string;
  readonly source: string;
  readonly description: string;
  readonly emergencyFlag: boolean;
  readonly attachmentCount: number;
}
interface StaffJobDetail extends StaffJob {
  readonly attachments: readonly { readonly kind: string; readonly stage: string }[];
  readonly tenantResponse: { readonly kind: string; readonly via: string } | null;
}

let agency: APIRequestContext;
let context: BrowserContext;
let page: Page;
let tenantId: string;
let jobId: string;

/** The tenant's jobs as the agency's board lists them, this run's description only. */
async function jobsOnTheBoard(): Promise<StaffJob[]> {
  const listed = await ok<{ items: StaffJob[] }>(
    await agency.get(`/maintenance-jobs?tenantId=${tenantId}&limit=100`),
    'the maintenance board',
  );
  return listed.items.filter((job) => job.description === DESCRIPTION);
}

const job = async () =>
  ok<StaffJobDetail>(await agency.get(`/maintenance-jobs/${jobId}`), 'the job');

/** A photo sent to storage as staff do, for the job's after photo. */
async function staffPhoto(): Promise<string> {
  const slot = await ok<{ uploadId: string; url: string; fields: Record<string, string> }>(
    await agency.post('/maintenance-uploads', {
      data: { contentType: 'image/png', sizeBytes: PNG.length },
    }),
    'ask for an upload',
  );
  // Storage wants the policy fields first and the file last, as a browser sends them.
  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'after.png');
  const stored = await fetch(slot.url, { method: 'POST', body: form });
  expect(stored.ok, `upload the after photo: ${stored.status}`).toBe(true);
  return slot.uploadId;
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
  await context?.setOffline(false);
  await context?.close();
  await agency?.dispose();
});

test.describe('MI-01 a repair from the tenant app (decision 3)', () => {
  test('written offline with a photo and a voice note, it waits, then arrives once with both files', async () => {
    await page.getByTestId('open-repairs').click();
    await expect(page.getByTestId('repair-row')).toHaveCount(0);
    await page.getByTestId('report-repair').click();
    await page.getByTestId('category-plumbing').click();
    await page.getByTestId('repair-description').fill(DESCRIPTION);

    const photo = page.waitForEvent('filechooser');
    await page.getByTestId('choose-media').click();
    await (
      await photo
    ).setFiles({ name: 'ceiling.png', mimeType: 'image/png', buffer: NodeBuffer.from(PNG) });
    const voice = page.waitForEvent('filechooser');
    await page.getByTestId('choose-voice').click();
    await (
      await voice
    ).setFiles({
      name: 'voice-note.mp3',
      mimeType: 'audio/mpeg',
      buffer: NodeBuffer.from(silentMp3(2)),
    });
    const files = page.getByTestId('repair-file');
    await expect(files).toHaveCount(2);
    await expect(files.nth(0)).toHaveText(/^Photo /);
    await expect(files.nth(1)).toHaveText(/^Voice note \(0:0[123]\)/);
    await expect(page.getByTestId('repair-problem')).toHaveCount(0);

    // Offline: nothing reaches the API, and the request waits in the app.
    await context.setOffline(true);
    await page.getByTestId('send-repair').click();
    await expect(page.getByTestId('repair-waiting')).toHaveText(/saved on this phone/);
    expect(await jobsOnTheBoard()).toHaveLength(0);
    await page.getByTestId('see-repairs').click();
    // A web stack keeps the screens below the current one in the page, hidden: what the tenant
    // sees is the visible copy.
    const queued = page.getByTestId('queued-repair').filter({ visible: true });
    await expect(queued).toHaveCount(1);
    await expect(queued.getByTestId('queued-state')).toHaveText('Not sent yet');

    // Back online: the app sends it by itself; Send now, if it is still there, sends the same
    // request with the same client id.
    await context.setOffline(false);
    await queued
      .getByTestId('send-queued')
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    // Gone from the phone: no screen, shown or hidden, lists it as waiting.
    await expect(page.getByTestId('queued-repair')).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.getByTestId('repair-row').filter({ visible: true }).filter({ hasText: DESCRIPTION }),
    ).toHaveCount(1);

    await expect
      .poll(async () => (await jobsOnTheBoard()).length, { message: 'the job reaches the board' })
      .toBe(1);
    const [made] = await jobsOnTheBoard();
    jobId = made!.id;
    expect(made).toMatchObject({ source: 'app', emergencyFlag: false, attachmentCount: 2 });
    const detail = await job();
    expect(detail.attachments.map((a) => a.kind).sort()).toEqual(['audio', 'image']);
    expect(detail.attachments.every((a) => a.stage === 'report')).toBe(true);

    // The app coming back and sending what waits (a reload restores and flushes) makes nothing
    // more: the request is gone from the phone, and the API keeps one job for its client id.
    await page.reload();
    await expect(
      page.getByTestId('repair-row').filter({ visible: true }).filter({ hasText: DESCRIPTION }),
    ).toHaveCount(1);
    await expect(page.getByTestId('queued-repair')).toHaveCount(0);
    expect(await jobsOnTheBoard()).toHaveLength(1);
  });

  test('staff do the work; the tenant sees it done and confirms it, and the job closes', async () => {
    test.setTimeout(120_000);
    const me = await ok<{ personId: string }>(await agency.get('/me'), 'the manager');
    await ok(
      await agency.post(`/maintenance-jobs/${jobId}/triage`, {
        data: { priority: 'routine', category: 'plumbing' },
      }),
      'triage',
    );
    await ok(
      await agency.post(`/maintenance-jobs/${jobId}/assign`, {
        data: { assignee: { kind: 'staff', personId: me.personId } },
      }),
      'assign to the manager',
    );
    await ok(
      await agency.post(`/maintenance-jobs/${jobId}/start`, {
        data: { uploadIds: [], beforePhotoReason: 'The ceiling was opened before we arrived.' },
      }),
      'start the work',
    );
    await ok(
      await agency.post(`/maintenance-jobs/${jobId}/complete`, {
        data: { uploadIds: [await staffPhoto()], completionNote: COMPLETION_NOTE },
      }),
      'complete the work',
    );
    expect((await job()).status).toBe('work_done');

    await page.goto('/home');
    await expect(page.getByTestId('repairs-waiting')).toHaveText('Waiting for you');
    await page.getByTestId('open-repairs').click();
    const row = page
      .getByTestId('repair-row')
      .filter({ visible: true })
      .filter({ hasText: DESCRIPTION });
    await expect(row.getByTestId('repair-status')).toHaveText('Work done');
    await expect(row.getByTestId('completion-note')).toHaveText(
      `What was done: ${COMPLETION_NOTE}`,
    );
    await expect(row.getByTestId('repair-steps')).toContainText('Work done, ');
    await expect(row.getByTestId('repair-file').filter({ hasText: 'after the work' })).toHaveCount(
      1,
    );
    await row.getByTestId('confirm-repair').click();
    await expect(row.getByTestId('awaiting-response')).toHaveCount(0);
    await expect(row.getByTestId('repair-status')).toHaveText('Closed');

    const closed = await job();
    expect(closed.status).toBe('closed');
    expect(closed.tenantResponse).toMatchObject({ kind: 'confirmed', via: 'app' });
  });
});
