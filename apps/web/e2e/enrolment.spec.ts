import { expect, test } from '@playwright/test';
import { codeFor, DEMO_PASSWORD, enterPassword, PEOPLE, ready, submitAuth } from './helpers';

test.describe('AD-06 TOTP enrolment', () => {
  test('a new manager adds the key, saves the backup codes, confirms a code and lands in the app', async ({
    page,
  }) => {
    await enterPassword(page, PEOPLE.newManager.email);
    // A password-only session may do nothing but enrol. This needs a freshly seeded database:
    // once enrolled, the seed does not take the TOTP away again.
    await expect(
      page,
      'new.manager@demo.invalid already has TOTP; reset and reseed the demo database to rerun this test',
    ).toHaveURL(/\/enrol$/);
    await page.goto('/settings/users');
    await expect(page).toHaveURL(/\/enrol$/);

    await ready(page, 'Continue');
    await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(
      page.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    const secret = (await page.getByTestId('totp-secret').innerText()).replace(/\s+/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    await page.getByRole('button', { name: 'I have added it' }).click();

    await expect(page.getByTestId('backup-codes').getByRole('listitem')).not.toHaveCount(0);
    const next = page.getByRole('button', { name: 'Continue' });
    await expect(next).toBeDisabled();
    await page.getByLabel('I have saved these backup codes').check();
    await next.click();

    const response = await submitAuth(page, '/api/auth/two-factor/verify-totp', async () => {
      await page.getByLabel('6-digit code').fill(await codeFor(secret));
      await page.getByRole('button', { name: 'Confirm' }).click();
    });
    expect(response.status()).toBe(200);
    await expect(page.getByTestId('shell-person')).toHaveText(PEOPLE.newManager.name);
    await expect(page).toHaveURL(/\/$/);
  });
});
