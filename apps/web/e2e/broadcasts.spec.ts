import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import { letUnits } from './messaging-helpers';
import { FAKE_PROVIDERS } from './register-helpers';

/**
 * M6: broadcasts (CM-08; plan 4.7). Needs the stack running with the demo seed and the fake
 * providers. The test makes its own property with two tenants: one who agreed to SMS, one who
 * agreed to nothing, so the preview has someone it can reach and someone it cannot.
 */
test.describe('CM-08 broadcasts', () => {
  test('a manager previews a broadcast, sends it to the tenants who can be reached, and sees its delivery per channel', async ({
    page,
  }) => {
    const tag = unique();
    const reachable = `Ama Reachable ${tag} (e2e)`;
    const unreachable = `Kojo Unreachable ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const [agreed, silent] = await letUnits(page, [
      { name: reachable, extra: { consent: { sms: true } } },
      { name: unreachable },
    ]);
    const topic = `Water supply ${tag}`;
    const body = `The water will be off on Saturday from 9 to 12 for repairs. ${tag}`;

    await nav(page).getByRole('link', { name: 'Broadcasts' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Broadcasts');
    await page.getByRole('link', { name: 'New broadcast' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('New broadcast');
    await ready(page, 'Preview who it reaches');

    const form = page.getByRole('form', { name: 'Broadcast' });
    await expect(form.getByLabel('Audience')).toHaveValue('property');
    await form.getByLabel('Property').selectOption(agreed!.propertyId);
    await form.getByLabel('Topic').fill(topic);
    await form.getByLabel('Message').fill(body);
    // Nothing goes before the preview.
    await expect(page.getByRole('button', { name: /^Send to/ })).toHaveCount(0);
    await form.getByRole('button', { name: 'Preview who it reaches' }).click();

    const preview = page.getByTestId('broadcast-preview');
    await expect(preview.getByTestId('preview-reach')).toHaveText('1 of 2 tenants can be reached.');
    // By first channel: app notifications, WhatsApp, SMS, email.
    await expect(preview.getByTestId('preview-channels').getByRole('cell')).toHaveText([
      '0',
      '0',
      '1',
      '0',
    ]);
    const cannot = preview.getByTestId('preview-unreachable').filter({ hasText: unreachable });
    await expect(cannot).toContainText('No consent on any channel');
    await expect(cannot).toContainText(silent!.unitCode);
    await expect(
      preview.getByTestId('preview-unreachable').filter({ hasText: reachable }),
    ).toHaveCount(0);

    // A change after the preview needs a new one before anything can go.
    await form.getByLabel('Message').fill(`${body}!`);
    await expect(page.getByTestId('broadcast-preview')).toHaveCount(0);
    await form.getByLabel('Message').fill(body);
    await expect(preview.getByRole('button', { name: 'Send to 1 tenant' })).toBeVisible();

    await preview.getByRole('button', { name: 'Send to 1 tenant' }).click();
    await expect(page).toHaveURL(/\/broadcasts\/[0-9a-f-]{36}\?sent=1$/);
    const broadcastId = /\/broadcasts\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(topic);
    await expect(page.getByText('Sent to 1 of 2 tenants.')).toBeVisible();

    // The fan-out sends in batches; wait for the SMS to have gone.
    await expect
      .poll(
        async () => {
          const stored = (await (
            await page.request.get(`/api/v1/broadcasts/${broadcastId}`)
          ).json()) as {
            stats: { byChannel: { sms: { sent: number; delivered: number; read: number } } };
          };
          const sms = stored.stats.byChannel.sms;
          return sms.sent + sms.delivered + sms.read;
        },
        { message: 'the SMS to the reachable tenant went', timeout: 30_000 },
      )
      .toBe(1);
    await page.reload();
    const stats = page.getByTestId('broadcast-stats');
    await expect(stats.getByTestId('stats-row').filter({ hasText: 'SMS' })).toBeVisible();
    const total = stats.getByTestId('stats-row').filter({ hasText: 'Total' });
    await expect(total.getByTestId('stat-notSent')).toHaveText('1');
    await expect(
      page
        .getByTestId('recipient-row')
        .filter({ hasText: reachable })
        .getByTestId('message-status'),
    ).toHaveText(/Sent|Delivered|Read/);
    await expect(
      page
        .getByTestId('recipient-row')
        .filter({ hasText: unreachable })
        .getByTestId('message-status'),
    ).toHaveText('Not sent');

    // It reached the tenant's phone, and nobody else's.
    const toAgreed = (await (
      await page.request.get(
        `${FAKE_PROVIDERS}/messages?channel=sms&to=${encodeURIComponent(agreed!.phone)}`,
      )
    ).json()) as { body: string }[];
    expect(toAgreed.some((m) => m.body.includes(tag))).toBe(true);
    const toSilent = (await (
      await page.request.get(`${FAKE_PROVIDERS}/messages?to=${encodeURIComponent(silent!.phone)}`)
    ).json()) as { body: string }[];
    expect(toSilent.some((m) => m.body.includes(tag))).toBe(false);

    // The list shows it with its delivery.
    await page.goto('/broadcasts');
    const row = page.getByTestId('broadcast-row').filter({ hasText: topic });
    await expect(row).toContainText(PEOPLE.managerOne.name);
    await expect(row).toContainText('(Africa/Accra)');
  });
});
