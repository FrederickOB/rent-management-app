import { expect, test, type APIRequestContext } from '@playwright/test';
import { headerValues } from './support';
import { freshPhone, managerApi, ok, smsTo } from './signing-support';

// The artisan's job sheet (MI-04, MI-06; M8 decision 6 and plan 4.5). The demo manager (the
// agency, on Growth) logs a repair on a room of a new property, triages it and gives it to a new
// artisan with SMS consent, so the job sheet link goes to the artisan's phone by SMS. The artisan
// accepts, starts with a before photo, and sends the finished work with an after photo, a note
// and the one-time code sent to the phone on record. The room has no tenant, so the manager
// closes the job, and the link then says it is closed.
// Needs pnpm db:seed and the running stack; every run makes its own property, artisan and job.
test.describe.configure({ mode: 'serial' });

const ONE_MB = 1_000_000;
const ARTISAN = 'Kwame Fixes-Pipes (e2e)';
const DESCRIPTION = `The kitchen tap drips and the pipe under the sink leaks. (e2e ${Date.now()})`;
const COMPLETION_NOTE = 'Replaced the tap washer and the trap under the sink.';
const SHEET_PATH = /\/j\/[A-Za-z0-9_-]{43}/;
/** A 1-by-1 PNG: the API reads the type from the first bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const photo = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG });

interface JobDetail {
  readonly id: string;
  readonly ticket: string;
  readonly status: string;
  readonly assignee: { readonly kind: string; readonly response?: string | null } | null;
  readonly attachments: readonly {
    readonly kind: string;
    readonly stage: string;
    readonly addedByKind: string;
  }[];
  readonly completionNote: string | null;
}

let staff: APIRequestContext;
let artisanPhone: string;
let jobId: string;
let ticket: string;
let unitCode: string;
let path: string;

const job = async () =>
  ok<JobDetail>(await staff.get(`/maintenance-jobs/${jobId}`), `job ${ticket}`);

/** A property of one single room for the agency's owner OWN-01, made through the API. */
async function newRoom(): Promise<{ propertyId: string; unitId: string; code: string }> {
  const owners = await ok<{ id: string; reference: string }[]>(
    await staff.get('/owners'),
    'owners',
  );
  const owner = owners.find((o) => o.reference === 'OWN-01');
  if (!owner) throw new Error('No OWN-01: run pnpm db:seed');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const part = Array.from({ length: 4 }, () =>
      String.fromCharCode(65 + Math.trunc(Math.random() * 26)),
    ).join('');
    const response = await staff.post('/properties', {
      data: {
        areaCode: 'ACC',
        propertyPart: part,
        name: `Job sheet test rooms ${part} (e2e)`,
        propertyType: 'compound_house',
        use: 'residential',
        ownerId: owner.id,
        address: { region: 'Greater Accra', town: 'Madina' },
        units: [{ unitType: 'single_room', count: 1 }],
      },
    });
    if (response.status() === 409) continue;
    const property = await ok<{ id: string; blocks: { units: { id: string; code: string }[] }[] }>(
      response,
      'create a property',
    );
    const [unit] = property.blocks.flatMap((b) => b.units);
    return { propertyId: property.id, unitId: unit!.id, code: unit!.code };
  }
  throw new Error('no free property code');
}

/** The newest SMS to the artisan since `after` that matches, waiting for the worker to send it. */
async function smsToArtisan(pattern: RegExp, after: number, what: string): Promise<string> {
  let found = '';
  await expect
    .poll(
      async () => {
        const message = (await smsTo(artisanPhone)).find(
          (m) => pattern.test(m.body) && Date.parse(m.at) >= after - 1_000,
        );
        found = message?.body ?? '';
        return found !== '';
      },
      { message: `${what} reaches the artisan by SMS`, timeout: 45_000 },
    )
    .toBe(true);
  return found;
}

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  testInfo.setTimeout(120_000);
  staff = await managerApi();
  const room = await newRoom();
  unitCode = room.code;
  artisanPhone = freshPhone();
  const artisan = await ok<{ id: string }>(
    await staff.post('/artisans', {
      data: {
        name: ARTISAN,
        phone: artisanPhone,
        trades: ['plumbing'],
        consent: { whatsapp: false, sms: true },
      },
    }),
    'add an artisan',
  );
  const reported = await ok<JobDetail>(
    await staff.post('/maintenance-jobs', {
      data: { propertyId: room.propertyId, unitId: room.unitId, description: DESCRIPTION },
    }),
    'log a repair',
  );
  jobId = reported.id;
  ticket = reported.ticket;
  await ok(
    await staff.post(`/maintenance-jobs/${jobId}/triage`, {
      data: { priority: 'urgent', category: 'plumbing' },
    }),
    'triage the job',
  );
  const assignedAt = Date.now();
  await ok(
    await staff.post(`/maintenance-jobs/${jobId}/assign`, {
      data: { assignee: { kind: 'artisan', artisanId: artisan.id } },
    }),
    'give the job to the artisan',
  );
  const sms = await smsToArtisan(SHEET_PATH, assignedAt, 'the job sheet link');
  path = SHEET_PATH.exec(sms)![0];
});

test.afterAll(async () => {
  await staff?.dispose();
});

test.describe('MI-04 the artisan’s job sheet (decision 6)', () => {
  test('NFR-PERF the sheet transfers under 1 MB, fits a 5-inch screen, sets no cookie and is never cached', async ({
    page,
    request,
  }, testInfo) => {
    const transfers: Promise<number>[] = [];
    page.on('requestfinished', (finished) => {
      transfers.push(
        finished.sizes().then((sizes) => sizes.responseHeadersSize + sizes.responseBodySize),
      );
    });
    await page.goto(path, { waitUntil: 'networkidle' });
    const transferred = (await Promise.all(transfers)).reduce((total, size) => total + size, 0);
    testInfo.annotations.push({
      type: 'page weight',
      description: `the job sheet: ${transfers.length} requests, ${transferred} bytes transferred`,
    });
    expect(transferred).toBeLessThan(ONE_MB);

    expect(page.viewportSize()).toEqual({ width: 360, height: 640 });
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(headerValues(response.headersArray(), 'set-cookie')).toEqual([]);
  });

  test('shows the job, the unit and the property contact, and never the link’s token', async ({
    page,
  }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Job ${ticket}: Plumbing`);
    await expect(page.getByText(`${ARTISAN}, `)).toBeVisible();
    await expect(page.getByText(DESCRIPTION)).toBeVisible();
    await expect(page.getByRole('definition').filter({ hasText: unitCode })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Questions about this job?' })).toBeVisible();
    const text = await page.locator('body').innerText();
    // The artisan's own number is the code's destination, and is never printed in full.
    expect(text).not.toContain(artisanPhone);
    expect(text).not.toContain(path.slice(3));
    expect(await page.title()).not.toContain(path.slice(3));
  });

  test('accept, then start with a before photo', async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Can you do this job?' })).toBeVisible();
    await page.getByRole('button', { name: 'Accept the job' }).click();
    await expect(page.getByRole('heading', { name: 'Start the work' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept the job' })).toHaveCount(0);
    expect((await job()).assignee).toMatchObject({ kind: 'artisan', response: 'accepted' });

    // Neither a photo nor a reason: refused, and the job does not move.
    await page.getByRole('button', { name: 'Start the work' }).click();
    await expect(page.locator('main').getByRole('alert')).toHaveText(
      'Add a photo from before you start, or say why there is none.',
    );
    expect((await job()).status).toBe('assigned');

    await page.getByLabel('A photo from before you start').setInputFiles(photo('before.png'));
    await page.getByRole('button', { name: 'Start the work' }).click();
    await expect(page.getByRole('heading', { name: 'Finish the work' })).toBeVisible();
    const started = await job();
    expect(started.status).toBe('in_progress');
    expect(started.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'image', stage: 'before', addedByKind: 'artisan' }),
      ]),
    );
  });

  test('complete with an after photo, a note and the code sent to the artisan’s phone', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto(path);
    const asked = Date.now();
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page.getByText(/We sent a code by SMS to/)).toBeVisible();
    const sms = await smsToArtisan(/\b\d{6}\b/, asked, 'the one-time code');
    expect(sms).not.toMatch(SHEET_PATH);
    const code = /\b(\d{6})\b/.exec(sms)![1]!;

    // A wrong code first: refused, and the work is not recorded.
    await page.getByLabel('Photos of the finished work').setInputFiles(photo('after.png'));
    await page.getByLabel('What did you do?').fill(COMPLETION_NOTE);
    await page.getByLabel('Your 6-digit code').fill(code === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: 'Send the finished work' }).click();
    await expect(page.locator('main').getByRole('alert')).toBeVisible();
    expect((await job()).status).toBe('in_progress');

    await page.getByLabel('Photos of the finished work').setInputFiles(photo('after.png'));
    await page.getByLabel('What did you do?').fill(COMPLETION_NOTE);
    await page.getByLabel('Your 6-digit code').fill(code);
    await page.getByRole('button', { name: 'Send the finished work' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Thank you: the work is recorded as done',
    );
    await expect(page.locator('main').getByRole('status')).toHaveText(
      `Job ${ticket}: Plumbing is waiting for the tenant to confirm it.`,
    );

    const done = await job();
    expect(done.status).toBe('work_done');
    expect(done.completionNote).toBe(COMPLETION_NOTE);
    expect(done.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'image', stage: 'after', addedByKind: 'artisan' }),
      ]),
    );

    // Opened again, the sheet says the work is done and offers nothing more.
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'The work is recorded as done',
    );
    await expect(page.locator('form')).toHaveCount(0);
  });

  test('once the job closes, the link says it is closed and offers nothing', async ({ page }) => {
    // The room is empty, so no tenant confirms: the manager closes the job (a tenant's
    // confirmation is refused with 409 NO_TENANT on a job with no tenant).
    await ok(
      await staff.post(`/maintenance-jobs/${jobId}/close`, {
        data: { note: 'Checked the work on site; no tenant to confirm it.' },
      }),
      'close the job as the manager',
    );
    expect((await job()).status).toBe('closed');

    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This job is closed');
    await expect(page.getByText('Nothing more is needed from you on this job.')).toBeVisible();
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Photo|Video|Voice note/ })).toHaveCount(0);
  });
});
