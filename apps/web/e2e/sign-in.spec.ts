import { expect, test } from '@playwright/test';
import { demoCode, enterCode, enterPassword, PEOPLE, signIn, wrongCode } from './helpers';

test.describe('AD-06 staff sign-in', () => {
  test('a password and the current TOTP code reach the app', async ({ page }) => {
    await signIn(page, PEOPLE.accountant.email);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('shell-person')).toHaveText(PEOPLE.accountant.name);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `Welcome, ${PEOPLE.accountant.name}`,
    );
  });

  test('a wrong TOTP code is refused', async ({ page }) => {
    await enterPassword(page, PEOPLE.accountant.email);
    await expect(page).toHaveURL(/\/sign-in\/verify$/);

    const refused = await enterCode(page, wrongCode);
    expect(refused.status()).toBe(401);
    await expect(
      page.getByRole('alert').filter({ hasText: 'That code is not right' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in\/verify$/);
    await expect(page.getByTestId('app-header')).toHaveCount(0);

    // The right code still works, which also resets the account's failed-attempt count.
    const accepted = await enterCode(page, demoCode);
    expect(accepted.status()).toBe(200);
    await expect(page.getByTestId('shell-person')).toHaveText(PEOPLE.accountant.name);
  });
});
