import { expect, test, type Browser } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import {
  jobInProgress,
  newExpense,
  newJob,
  uploadJobPhoto,
  type JobRef,
} from './maintenance-helpers';
import { expectNoSidewaysScroll, fixture, OWNER_A, OWNER_B } from './register-helpers';
import { cedis, myPersonId } from './tax-helpers';
import { newPropertyWithUnits, today } from './tenancy-helpers';

/**
 * M8 (plan 6, ★): a job is never marked done without an after photo and a completion note; an
 * agency's client owner sees every job on their property, its cost and its photos, and never
 * another owner's; an inspection is filled in at phone width. Each test makes its own property
 * for Owner A (OWN-01) through the API, so reruns do not depend on what earlier runs changed.
 */

test.describe('MI-06 ★ closing a job needs an after photo and a completion note', () => {
  test('the form says both are required, the API refuses without a photo, and with both the work is done', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const { propertyId, units } = await newPropertyWithUnits(page, 1);
    const job = await newJob(page, {
      propertyId,
      unitId: units[0]!.id,
      description: `The kitchen tap drips day and night ${unique()} (e2e)`,
    });
    await jobInProgress(page, job.id, await myPersonId(page));

    await page.goto(`/repairs/${job.id}`);
    await expect(page.getByTestId('repair-status')).toHaveText('In progress');
    const actions = page.getByTestId('job-actions');
    await ready(page, 'Mark the work done');
    await actions.getByRole('button', { name: 'Mark the work done' }).click();
    const form = page.getByRole('form', { name: 'Mark the work done' });
    await expect(form).toContainText('Both are required');

    // Nothing given: both are asked for, and nothing is sent.
    await form.getByRole('button', { name: 'Mark the work done' }).click();
    await expect(form).toContainText('Add at least one photo of the finished work');
    await expect(form).toContainText('Write what was done, at least 3 characters');

    // A note alone is not enough.
    await form
      .getByLabel('Completion note (required)')
      .fill('Replaced the tap washer and tested it.');
    await form.getByRole('button', { name: 'Mark the work done' }).click();
    await expect(form).toContainText('Add at least one photo of the finished work');
    await expect(page.getByTestId('repair-status')).toHaveText('In progress');

    // The API refuses it too, whatever the screen does.
    const refused = await page.request.post(`/api/v1/maintenance-jobs/${job.id}/complete`, {
      data: { uploadIds: [], completionNote: 'Replaced the tap washer and tested it.' },
    });
    expect(refused.status()).toBe(400);
    expect(((await refused.json()) as { code?: string }).code?.toUpperCase()).toBe(
      'MAINTENANCE_AFTER_PHOTO_REQUIRED',
    );

    // With an after photo and the note, the work is done.
    await form.getByLabel('After photos (required)').setInputFiles(fixture('property-photo.jpg'));
    await expect(form.getByTestId('picked-file')).toHaveCount(1);
    await form.getByRole('button', { name: 'Mark the work done' }).click();
    await expect(page.getByText('Marked the work done.')).toBeVisible();
    await expect(page.getByTestId('repair-status')).toHaveText('Work done');
    await expect(page.getByTestId('completion-note')).toHaveText(
      'Replaced the tap washer and tested it.',
    );
    await expect(
      page.getByTestId('repair-attachment').and(page.locator('[data-stage="after"]')),
    ).toHaveCount(1);
  });
});

/** As a manager: a property of Owner A's, with a repair reported with a photo and an expense. */
async function jobWithPhotoAndExpense(
  browser: Browser,
  baseURL: string | undefined,
  tag: string,
  supplier: string,
): Promise<JobRef> {
  const manager = await browser.newContext({ baseURL });
  try {
    const page = await manager.newPage();
    await signIn(page, PEOPLE.managerOne.email);
    const { propertyId, units } = await newPropertyWithUnits(page, 1);
    const job = await newJob(page, {
      propertyId,
      unitId: units[0]!.id,
      description: `Water through the ceiling ${tag} (e2e)`,
      uploadIds: [await uploadJobPhoto(page)],
    });
    await newExpense(page, {
      propertyId,
      jobId: job.id,
      amountMinor: 45_000,
      supplierName: supplier,
      expenseDate: today(),
    });
    return job;
  } finally {
    await manager.close();
  }
}

test.describe('decision 9 ★ an owner sees every job on their property, its cost and its photos', () => {
  test('the client owner reads the job, its photos and its cost; another owner cannot see it', async ({
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const supplier = `Kwame Plumbing ${tag} (e2e)`;
    const job = await jobWithPhotoAndExpense(browser, baseURL, tag, supplier);

    const owner = await browser.newContext({ baseURL });
    try {
      const page = await owner.newPage();
      await signIn(page, OWNER_A.email);
      // A read-only entry: the board, not the managers' section.
      await expect(nav(page).getByRole('link', { name: 'Repairs', exact: true })).toBeVisible();
      await expect(nav(page).getByRole('link', { name: 'Artisans', exact: true })).toHaveCount(0);

      await page.goto('/repairs');
      await expect(page.getByText('Read only')).toBeVisible();
      await page.getByLabel('Search', { exact: true }).fill(job.ticket);
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const row = page.locator(`[data-testid="repair-row"][data-ticket="${job.ticket}"]`);
      await expect(row.getByTestId('job-cost')).toHaveText(cedis(45_000));

      await row.getByRole('link', { name: job.ticket }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Repair ${job.ticket}`);
      await expect(page.getByTestId('repair-description')).toContainText(
        `Water through the ceiling ${tag}`,
      );
      await expect(page.getByTestId('job-cost')).toHaveText(cedis(45_000));
      await expect(page.getByTestId('repair-expenses')).toContainText(supplier);
      // The photo, opened by a short-lived link, shows.
      const photo = page.getByTestId('repair-files').getByRole('img');
      await expect(photo).toHaveCount(1);
      await expect
        .poll(() => photo.evaluate((img) => (img as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      // Nothing to change: no steps are offered, and the API refuses one.
      await expect(page.getByTestId('job-read-only')).toBeVisible();
      await expect(page.getByTestId('job-actions')).toHaveCount(0);
      const triage = await page.request.post(`/api/v1/maintenance-jobs/${job.id}/triage`, {
        data: { priority: 'urgent', category: 'roofing' },
      });
      expect(triage.status()).toBe(403);
    } finally {
      await owner.close();
    }

    // Another owner of the agency never sees it.
    const other = await browser.newContext({ baseURL });
    try {
      const page = await other.newPage();
      await signIn(page, OWNER_B.email);
      const hidden = await page.request.get(`/api/v1/maintenance-jobs/${job.id}`);
      expect([403, 404]).toContain(hidden.status());
      const list = (await (
        await page.request.get(`/api/v1/maintenance-jobs?search=${job.ticket}`)
      ).json()) as {
        items?: { id: string }[];
      };
      expect((list.items ?? []).map((j) => j.id)).not.toContain(job.id);
    } finally {
      await other.close();
    }
  });
});

test.describe('MI-10 ★ an inspection is filled in on a phone', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('a manager records a condition, a note and a photo at 360 px wide, and submits once every item has a condition', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const { units } = await newPropertyWithUnits(page, 1);
    const started = await page.request.post('/api/v1/inspections', {
      data: { unitId: units[0]!.id, kind: 'routine' },
    });
    expect(started.status(), await started.text()).toBe(200);
    const inspection = (await started.json()) as { id: string; itemCount: number };

    await page.goto(`/inspections/${inspection.id}`);
    await expect(page.getByTestId('inspection-status')).toHaveText('In progress');
    await expectNoSidewaysScroll(page);

    const items = page.getByTestId('inspection-item');
    const first = items.first();
    const good = first.getByText('Good', { exact: true });
    // Touch-sized choices on a 5-inch screen.
    const box = await first.locator('label').filter({ hasText: 'Good' }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await good.click();
    await expect(page.getByTestId('inspection-progress')).toHaveText(
      `1 of ${inspection.itemCount} ${inspection.itemCount === 1 ? 'item' : 'items'} recorded`,
    );
    const note = first.getByRole('textbox');
    await note.fill('Freshly painted, no marks.');
    await note.blur();
    await first.locator('input[type="file"]').setInputFiles(fixture('property-photo.jpg'));
    await first.getByRole('button', { name: 'Add the photo' }).click();
    await expect(first.getByTestId('media-view')).toHaveCount(1);
    await expectNoSidewaysScroll(page);

    // Not yet: the other items still need a condition, and the page says how many.
    const left = inspection.itemCount - 1;
    if (left > 0) {
      await expect(page.getByTestId('inspection-submit')).toContainText(
        `${left} ${left === 1 ? 'item still needs' : 'items still need'} a condition`,
      );
      await expect(page.getByRole('button', { name: 'Submit the inspection' })).toBeDisabled();
    }
    const count = await items.count();
    for (let index = 1; index < count; index += 1) {
      const item = items.nth(index);
      await item.getByText('Fair', { exact: true }).click();
      await expect(item.getByRole('radio', { name: 'Fair' })).toBeChecked();
    }
    await expect(page.getByTestId('inspection-progress')).toHaveText(
      `${inspection.itemCount} of ${inspection.itemCount} ${inspection.itemCount === 1 ? 'item' : 'items'} recorded`,
    );
    await page.getByRole('button', { name: 'Submit the inspection' }).click();
    await page
      .getByRole('group', { name: 'Confirm the submission' })
      .getByRole('button', { name: 'Submit' })
      .click();
    await expect(page.getByText('Submitted. The inspection cannot change now')).toBeVisible();
    await expect(page.getByTestId('inspection-status')).toHaveText('Submitted');
    await expectNoSidewaysScroll(page);
  });
});
