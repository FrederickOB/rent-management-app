import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  jobForNewArtisan,
  largePng,
  smsSince,
  SHEET_PATH,
  type JobSheetJob,
} from './job-sheet-support';
import { managerApi, ok } from './signing-support';

// M8 review LT 1 and LT 6 (MI-06; decision 6). The artisan sends the finished work with two
// photos of 6 MB each, 12 MB in all: Next.js used to cut a post at 10 MB for its proxy, so the
// second photo never arrived whole. The first try has a wrong code: the photos are kept, and the
// retry sends the code alone, so they are uploaded once. Needs pnpm db:seed and the running
// stack; every run makes its own property, artisan and job.
test.describe.configure({ mode: 'serial' });

const DESCRIPTION = `The bathroom tiles are cracked and loose. (e2e ${Date.now()})`;
const NOTE = 'Took up the loose tiles, relaid the bed and replaced six cracked tiles.';
const SIX_MB = 6_000_000;

interface JobDetail {
  readonly status: string;
  readonly completionNote: string | null;
  readonly attachments: readonly {
    readonly kind: string;
    readonly stage: string;
    readonly addedByKind: string;
    readonly sizeBytes: number | null;
    readonly original: { readonly sha256: string; readonly bytes: number } | null;
  }[];
}

let staff: APIRequestContext;
let job: JobSheetJob;

const detail = async () =>
  ok<JobDetail>(await staff.get(`/maintenance-jobs/${job.jobId}`), `job ${job.ticket}`);

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  testInfo.setTimeout(120_000);
  staff = await managerApi();
  job = await jobForNewArtisan(staff, DESCRIPTION);
});

test.afterAll(async () => {
  await staff?.dispose();
});

test.describe('MI-06 the finished work with 12 MB of photos (review LT 1 and LT 6)', () => {
  test('accept, and start with a reason for no photo', async ({ page }) => {
    await page.goto(job.path);
    await page.getByRole('button', { name: 'Accept the job' }).click();
    await expect(page.getByRole('heading', { name: 'Start the work' })).toBeVisible();
    await page.getByLabel('No photo? Say why').fill('The tenant had already lifted the tiles.');
    await page.getByRole('button', { name: 'Start the work' }).click();
    await expect(page.getByRole('heading', { name: 'Finish the work' })).toBeVisible();
    expect((await detail()).status).toBe('in_progress');
  });

  test('a wrong code keeps both photos; the code alone then sends them, whole and once', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(job.path);
    const asked = Date.now();
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page.getByText(/We sent a code by SMS to/)).toBeVisible();
    const sms = await smsSince(job.artisanPhone, /\b\d{6}\b/, asked, 'the one-time code');
    expect(sms).not.toMatch(SHEET_PATH);
    const code = /\b(\d{6})\b/.exec(sms)![1]!;

    const photos = [largePng(SIX_MB), largePng(SIX_MB)];
    await page.getByLabel('Photos of the finished work').setInputFiles([
      { name: 'tiles-1.png', mimeType: 'image/png', buffer: photos[0]! },
      { name: 'tiles-2.png', mimeType: 'image/png', buffer: photos[1]! },
    ]);
    await page.getByLabel('What did you do?').fill(NOTE);
    await page.getByLabel('Your 6-digit code').fill(code === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: 'Send the finished work' }).click();
    await expect(page.locator('main').getByRole('alert')).toBeVisible();
    await expect(
      page.getByText('Your 2 photos of the finished work are kept from your last try.'),
    ).toBeVisible();
    expect((await detail()).status).toBe('in_progress');

    // The retry: the note and the code, no photos chosen.
    await page.getByLabel('What did you do?').fill(NOTE);
    await page.getByLabel('Your 6-digit code').fill(code);
    await page.getByRole('button', { name: 'Send the finished work' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Thank you: the work is recorded as done',
    );

    const done = await detail();
    expect(done.status).toBe('work_done');
    expect(done.completionNote).toBe(NOTE);
    const after = done.attachments.filter((a) => a.stage === 'after');
    expect(after).toHaveLength(2);
    // Whole: each upload, before it was re-encoded (M11 review R3 F10), is byte for byte what was
    // sent (founder decision, 2026-11-10).
    const sent = photos.map((bytes) => ({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    }));
    const bySha = (a: { sha256: string }, b: { sha256: string }) =>
      a.sha256.localeCompare(b.sha256);
    for (const photo of after) {
      expect(photo).toMatchObject({ kind: 'image', addedByKind: 'artisan' });
    }
    expect(after.map((photo) => photo.original!).sort(bySha)).toEqual(sent.sort(bySha));
  });
});
