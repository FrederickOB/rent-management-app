import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn } from './helpers';

type LeaseSettings = {
  witnessRequired: boolean;
  rentControlCommercial: boolean;
  rentControlReminderDaysBefore: number[];
  stampingReminderDaysBefore: number[];
  signingReminderHours: number[];
};

test.describe('decision 4, TX-05, OQ-45 and TL-07 lease settings', () => {
  test('an agency admin sets the witness rule and the reminder schedules, checked as the domain checks them', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    const before = (
      (await (await page.request.get('/api/v1/company')).json()) as { settings: LeaseSettings }
    ).settings;
    const original: LeaseSettings = {
      witnessRequired: before.witnessRequired,
      rentControlCommercial: before.rentControlCommercial,
      rentControlReminderDaysBefore: before.rentControlReminderDaysBefore,
      stampingReminderDaysBefore: before.stampingReminderDaysBefore,
      signingReminderHours: before.signingReminderHours,
    };
    try {
      await nav(page).getByRole('link', { name: 'Company settings' }).click();
      await ready(page, 'Save settings');
      await expect(page.getByLabel('A witness signs every lease')).toBeChecked();
      await expect(page.getByLabel('Signing reminders (hours after the links go out)')).toHaveValue(
        original.signingReminderHours.join(', '),
      );

      // Out of the domain's range: refused before anything is sent.
      await page.getByLabel('Signing reminders (hours after the links go out)').fill('0, 24');
      await page.getByLabel('Stamping reminders (days before the deadline)').fill('400');
      await page.getByRole('button', { name: 'Save settings' }).click();
      await expect(page.getByText('from 1 to 720 (30 days)')).toBeVisible();
      await expect(page.getByText('from 0 to 366')).toBeVisible();
      await expect(page.getByText('Settings saved.')).toHaveCount(0);

      await page.getByLabel('Signing reminders (hours after the links go out)').fill('12, 48');
      await page.getByLabel('Stamping reminders (days before the deadline)').fill('21 7');
      await page.getByLabel('Rent Control reminders (days before the deadline)').fill('10, 3, 0');
      await page.getByLabel('A witness signs every lease').uncheck();
      await page.getByLabel('Track Rent Control registration for commercial leases too').check();
      await page.getByRole('button', { name: 'Save settings' }).click();
      await expect(page.getByText('Settings saved.')).toBeVisible();

      const saved = (
        (await (await page.request.get('/api/v1/company')).json()) as { settings: LeaseSettings }
      ).settings;
      expect(saved).toMatchObject({
        witnessRequired: false,
        rentControlCommercial: true,
        rentControlReminderDaysBefore: [10, 3, 0],
        stampingReminderDaysBefore: [21, 7],
        signingReminderHours: [12, 48],
      });
      await page.reload();
      await ready(page, 'Save settings');
      await expect(page.getByLabel('A witness signs every lease')).not.toBeChecked();
      await expect(page.getByLabel('Stamping reminders (days before the deadline)')).toHaveValue(
        '21, 7',
      );
    } finally {
      // Always put the agency's settings back, whatever happened above.
      const restored = await page.request.patch('/api/v1/company/settings', { data: original });
      expect(restored.status(), 'restore the lease settings').toBe(200);
    }
  });
});
