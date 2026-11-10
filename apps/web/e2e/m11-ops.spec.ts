import { expect, test } from '@playwright/test';
import { WEBHOOK_STATUS_LABELS } from '../lib/ops';
import { unique } from './helpers';
import { ok, PLATFORM_ADMIN, platformAdmin } from './subscription-support';

/**
 * M11 plan section 6, end to end (web): replay from the console (decision 9). A platform admin
 * replays a failed webhook from System health with a reason and a confirmation; the row records
 * the replay and who made it, and a second replay changes nothing (idempotent replay).
 *
 * What it relies on:
 * - O1. The API's E2E test controls (on only with E2E_TEST_CONTROLS=on, as a platform admin):
 *   `POST /api/v1/_test/webhooks/failed { provider }` stores a webhook that failed processing and
 *   answers `{ id }`; replaying a paystack one ends `processed`, posting nothing.
 *   `POST /api/v1/_test/jobs/dead {}` dead-letters a harmless `ops.queue-age` job: `{ id }`.
 * - O2. The seeded platform admin holds `platform.ops.replay` and `platform.ops.redrive`.
 */

test.describe.configure({ timeout: 180_000 });

interface OpsWebhook {
  readonly id: string;
  readonly eventId: string;
  readonly status: string;
  readonly replayCount: number;
  readonly lastReplayedByName: string | null;
}

test.describe('NFR-AVAIL a failed webhook is replayed from the console, idempotently', () => {
  test('replayed with a reason and a confirmation; the row records it; a second replay changes nothing', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    try {
      const page = platform.page;
      const made = await ok<{ id: string }>(
        await page.request.post('/api/v1/_test/webhooks/failed', {
          data: { provider: 'paystack' },
        }),
        'store a failed webhook (assumed test control O1)',
      );
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
      const firstStatus = /: now (.+)\.$/.exec(await notice.innerText())![1]!;

      // Idempotent: replaying again changes nothing it recorded. The count shows both replays,
      // both by the platform admin, and the status stays where the first replay left it.
      const again = await ok<OpsWebhook>(
        await page.request.post(`/api/v1/platform/ops/webhooks/${made.id}/replay`, {
          data: { reason: `Replaying again to check idempotence ${unique()}` },
        }),
        'replay it again',
      );
      expect(again.replayCount).toBe(before.replayCount + 2);
      expect(again.lastReplayedByName).toBe(PLATFORM_ADMIN.name);
      expect(
        WEBHOOK_STATUS_LABELS[again.status as keyof typeof WEBHOOK_STATUS_LABELS].toLowerCase(),
      ).toBe(firstStatus);
    } finally {
      await platform.context.close();
    }
  });
});

test.describe('NFR-AVAIL a dead-lettered job is run again from the console', () => {
  test('run again with a reason and a confirmation, and it leaves the dead-letter list', async ({
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

      const jobs = await ok<{ id: string; retriedAt: string | null }[]>(
        await page.request.get('/api/v1/platform/ops/jobs'),
        'list the dead-lettered jobs',
      );
      const after = jobs.find((job) => job.id === dead.id);
      expect(after === undefined || after.retriedAt !== null, 'retried or gone from the list').toBe(
        true,
      );
    } finally {
      await platform.context.close();
    }
  });
});
