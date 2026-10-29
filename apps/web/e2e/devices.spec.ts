import { expect, test } from '@playwright/test';
import { nav, PEOPLE, signIn, unique } from './helpers';

test.describe('AD-06 devices and remote sign-out', () => {
  test('signing out another device from the devices page ends that session', async ({
    browser,
    baseURL,
  }) => {
    // Two browsers for the same person; the second has a user agent we can find in the list.
    const marker = `RentE2EOtherDevice/${unique()}`;
    const first = await browser.newContext({ baseURL });
    const second = await browser.newContext({
      baseURL,
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) ${marker}`,
    });
    try {
      const here = await first.newPage();
      const there = await second.newPage();
      await signIn(there, PEOPLE.managerTwo.email);
      await signIn(here, PEOPLE.managerTwo.email);

      await nav(here).getByRole('link', { name: 'My security' }).click();
      await expect(here.getByRole('heading', { level: 1 })).toHaveText('My security');
      await expect(here.getByTestId('session').filter({ hasText: 'This device' })).toHaveCount(1);
      const other = here.getByTestId('session').filter({ hasText: marker });
      await expect(other).toHaveCount(1);
      await other.getByRole('button', { name: 'Sign out' }).click();
      await expect(here.getByText('Signed out')).toBeVisible();
      await expect(here.getByTestId('session').filter({ hasText: marker })).toHaveCount(0);

      // The other browser is signed out on its next request.
      await there.reload();
      await expect(there).toHaveURL(/\/sign-in$/);
      await expect(there.getByRole('button', { name: 'Sign in' })).toBeVisible();

      // This one is not.
      await here.reload();
      await expect(here.getByTestId('shell-person')).toHaveText(PEOPLE.managerTwo.name);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
