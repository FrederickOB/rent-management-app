import { expect, test, type Page } from '@playwright/test';
import { PEOPLE, signIn, unique } from './helpers';
import { ok, PLATFORM_ADMIN, platformAdmin } from './subscription-support';
import { newPropertyWithUnits, newTenant, recordPaperLease, today } from './tenancy-helpers';

/**
 * M11 plan section 6, end to end (web): replay from the console (decision 9). A platform admin
 * replays a failed webhook from System health with a reason and a confirmation; the row records
 * the replay and who made it, and a second replay changes nothing (idempotent replay): the charge
 * it carries is posted once, as one payment with one receipt.
 *
 * What it relies on:
 * - O1. The API's E2E test controls (on only with E2E_TEST_CONTROLS=on, as a platform admin):
 *   `POST /api/v1/_test/webhooks/failed { provider, charge: true, companyId, invoiceId }` starts a
 *   real MoMo charge on the open invoice's pay link, has the fake provider mark it paid without its
 *   webhook, and stores that webhook as dead-lettered: `{ id, reference }`. Nothing is posted
 *   until a replay. `GET /api/v1/_test/payments?reference=` counts the payments and receipts.
 *   `POST /api/v1/_test/jobs/dead {}` dead-letters a harmless `ops.queue-age` job: `{ id }`.
 * - O2. The seeded platform admin holds `platform.ops.replay` and `platform.ops.redrive`.
 * - O3. Owner A's rent has an account to settle into (the seed), so the invoice has a pay link.
 *
 * M11 review C6 and C7 (founder, 2026-11-10: M11's own tests flagged as weak are strengthened,
 * never weakened): the replay is followed to `processed` through `GET /platform/ops/webhooks/{id}`
 * and the money counted; the retry is followed to its outcome, `sent`.
 */

test.describe.configure({ timeout: 180_000 });

interface OpsWebhook {
  readonly id: string;
  readonly eventId: string;
  readonly status: string;
  readonly replayCount: number;
  readonly lastReplayedByName: string | null;
}

/** Waits until the stored webhook's processing has finished: `processed`, or why not. */
async function processed(page: Page, id: string): Promise<OpsWebhook> {
  let row: OpsWebhook | undefined;
  await expect
    .poll(
      async () => {
        row = await ok<OpsWebhook>(
          await page.request.get(`/api/v1/platform/ops/webhooks/${id}`),
          'read the webhook',
        );
        return row.status;
      },
      { message: 'the replayed webhook is processed', timeout: 60_000 },
    )
    .toBe('processed');
  return row!;
}

/**
 * A lease of the seeded agency's Owner A, starting today, with its first month's invoice open:
 * made by the seeded manager, so the spec uses no seeded lease.
 */
async function openInvoiceOfNewLease(
  staff: Page,
): Promise<{ companyId: string; invoiceId: string }> {
  const me = await ok<{ activeCompanyId: string | null }>(
    await staff.request.get('/api/v1/me'),
    'read the manager’s company',
  );
  const { units } = await newPropertyWithUnits(staff, 1);
  const tenantName = `Efua Replay ${unique()} (e2e)`;
  const tenant = await newTenant(staff, tenantName);
  const leaseId = await recordPaperLease(staff, {
    unitId: units[0]!.id,
    tenantId: tenant.id,
    tenantName,
    startDate: today(),
    months: 12,
    monthlyRentMinor: 50_000,
    signedOn: today(),
  });
  let invoiceId: string | undefined;
  await expect
    .poll(
      async () => {
        const rows = await ok<{ id: string; kind: string; outstandingMinor: number }[]>(
          await staff.request.get(`/api/v1/invoices?leaseId=${leaseId}`),
          'the lease’s invoices',
        );
        invoiceId = rows.find((r) => r.kind === 'cycle' && r.outstandingMinor > 0)?.id;
        return Boolean(invoiceId);
      },
      { message: 'billing issues the first month’s invoice', timeout: 45_000 },
    )
    .toBe(true);
  return { companyId: me.activeCompanyId!, invoiceId: invoiceId! };
}

test.describe('NFR-AVAIL a failed webhook is replayed from the console, idempotently', () => {
  test('replayed with a reason and a confirmation; the row records it; a second replay changes nothing', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const staff = await browser.newContext({ baseURL });
    try {
      const page = platform.page;
      const manager = await staff.newPage();
      await signIn(manager, PEOPLE.managerOne.email);
      const { companyId, invoiceId } = await openInvoiceOfNewLease(manager);
      const made = await ok<{ id: string; reference: string }>(
        await page.request.post('/api/v1/_test/webhooks/failed', {
          data: { provider: 'paystack', charge: true, companyId, invoiceId },
        }),
        'store a failed webhook for a real charge (test control O1)',
      );
      const money = async () =>
        ok<{ payments: number; receipts: number }>(
          await page.request.get(
            `/api/v1/_test/payments?reference=${encodeURIComponent(made.reference)}`,
          ),
          'count the charge’s payments and receipts',
        );
      // Nothing is posted until the webhook is replayed.
      expect(await money()).toEqual({ payments: 0, receipts: 0 });
      const listed = await ok<OpsWebhook[]>(
        await page.request.get('/api/v1/platform/ops/webhooks'),
        'list the failed webhooks',
      );
      const hook = listed.find((w) => w.id === made.id);
      expect(hook, 'the stored webhook is listed').toBeTruthy();
      const before = hook!;

      await page.goto('/platform/health');
      const item = page.locator(`[data-webhook-id="${made.id}"]`);
      await expect(item).toHaveCount(1);

      // A reason is required, then a confirmation.
      await item.getByRole('button', { name: 'Replay', exact: true }).click();
      const reason = item.getByLabel(`Why replay webhook ${before.eventId}`);
      await reason.fill('ok');
      await item.getByRole('button', { name: 'Replay', exact: true }).click();
      await expect(item).toContainText('at least 5 characters');
      await reason.fill(`Provider recovered at 09:00, replaying ${unique()}`);
      await item.getByRole('button', { name: 'Replay', exact: true }).click();
      await item
        .getByRole('group', { name: `Confirm: replay webhook ${before.eventId}` })
        .getByRole('button', { name: 'Yes, replay it' })
        .click();
      const notice = page.getByText(new RegExp(`^Replayed ${before.eventId}: now `));
      await expect(notice).toBeVisible();

      // The replay runs the normal path to the end: the charge is verified and posted, once.
      await processed(page, made.id);
      expect(await money()).toEqual({ payments: 1, receipts: 1 });

      // Idempotent: replaying again changes nothing it recorded. The count shows both replays,
      // both by the platform admin; the second also ends processed, and the charge is still one
      // payment with one receipt.
      await ok<OpsWebhook>(
        await page.request.post(`/api/v1/platform/ops/webhooks/${made.id}/replay`, {
          data: { reason: `Replaying again to check idempotence ${unique()}` },
        }),
        'replay it again',
      );
      const again = await processed(page, made.id);
      expect(again.replayCount).toBe(before.replayCount + 2);
      expect(again.lastReplayedByName).toBe(PLATFORM_ADMIN.name);
      expect(await money()).toEqual({ payments: 1, receipts: 1 });
    } finally {
      await staff.close();
      await platform.context.close();
    }
  });
});

test.describe('NFR-AVAIL a dead-lettered job is run again from the console', () => {
  test('run again with a reason and a confirmation, and it is sent back to its queue', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    try {
      const page = platform.page;
      const dead = await ok<{ id: string }>(
        await page.request.post('/api/v1/_test/jobs/dead', { data: {} }),
        'dead-letter a job (test control O1)',
      );
      const listed = await ok<{ id: string; name: string }[]>(
        await page.request.get('/api/v1/platform/ops/jobs'),
        'list the dead-lettered jobs',
      );
      const name = listed.find((job) => job.id === dead.id)?.name;
      expect(name, 'the dead-lettered job is listed').toBeTruthy();
      await page.goto('/platform/health');
      const item = page.locator(`[data-job-id="${dead.id}"]`);
      await expect(item).toHaveCount(1);

      await item.getByRole('button', { name: 'Run again', exact: true }).click();
      await item
        .getByLabel(`Why run again job ${name}`)
        .fill(`Queue age check failed during the drill ${unique()}`);
      await item.getByRole('button', { name: 'Run again', exact: true }).click();
      await item
        .getByRole('group', { name: `Confirm: run again job ${name}` })
        .getByRole('button', { name: 'Yes, run it again' })
        .click();
      await expect(page.getByText(`${name} is back on its queue.`)).toBeVisible();

      // The retry ran: the worker sent the job back to its queue (M11 review C7).
      await expect
        .poll(
          async () => {
            const jobs = await ok<
              { id: string; retriedAt: string | null; retryOutcome: string | null }[]
            >(await page.request.get('/api/v1/platform/ops/jobs'), 'list the dead-lettered jobs');
            const after = jobs.find((job) => job.id === dead.id);
            return after
              ? { retried: after.retriedAt !== null, outcome: after.retryOutcome }
              : null;
          },
          { message: 'the retry is sent back to its queue', timeout: 60_000 },
        )
        .toEqual({ retried: true, outcome: 'sent' });

      // Once per dead letter: the console no longer offers it, and the API refuses a second.
      await page.reload();
      await expect(item).toHaveCount(1);
      await expect(item.getByRole('button', { name: 'Run again', exact: true })).toHaveCount(0);
      const twice = await page.request.post(`/api/v1/platform/ops/jobs/${dead.id}/retry`, {
        data: { reason: `Running it a second time ${unique()}` },
      });
      expect(twice.status(), 'a second retry is refused (review B12)').toBe(409);
    } finally {
      await platform.context.close();
    }
  });
});
