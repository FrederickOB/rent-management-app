import { expect, test } from '@playwright/test';
import { ready } from './helpers';

test.describe('AD-03 accept invite', () => {
  test('an expired or used link says so instead of showing the form', async ({ page }) => {
    await page.goto('/accept-invite?error=INVALID_TOKEN');
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(page.getByLabel('New password')).toHaveCount(0);
  });

  test('a token the server does not know is refused when the password is set', async ({ page }) => {
    await page.goto('/accept-invite?token=not-a-real-invitation-token');
    await ready(page, 'Set password');
    await page.getByLabel('New password').fill('a long enough passphrase');
    await page.getByLabel('Repeat the password').fill('a long enough passphrase');
    const responded = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/auth/reset-password',
    );
    await page.getByRole('button', { name: 'Set password' }).click();
    expect((await responded).status()).toBe(400);
    await expect(
      page.getByRole('alert').filter({ hasText: 'This link is not valid or has expired.' }),
    ).toBeVisible();
  });

  test('the two passwords must match before anything is sent', async ({ page }) => {
    await page.goto('/accept-invite?token=not-a-real-invitation-token');
    await ready(page, 'Set password');
    await page.getByLabel('New password').fill('a long enough passphrase');
    await page.getByLabel('Repeat the password').fill('a different passphrase');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'The two passwords are not the same.' }),
    ).toBeVisible();
  });
});
