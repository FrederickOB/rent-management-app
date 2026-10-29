import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';

test.describe('AD-03 users and roles', () => {
  test('the agency admin sees everyone and the controls to manage them', async ({ page }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    await nav(page).getByRole('link', { name: 'Users and roles' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Users and roles');

    const rows = page.getByTestId('membership-row');
    await expect(rows.filter({ hasText: PEOPLE.managerOne.name })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Kojo Caretaker (demo)' })).toContainText('Caretaker');
    await expect(page.getByRole('button', { name: 'Invite someone' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: `Change ${PEOPLE.managerOne.name}` }),
    ).toBeVisible();
    // Nobody changes or removes themselves.
    const own = rows.filter({ hasText: PEOPLE.agencyAdmin.name });
    await expect(own).toContainText('(you)');
    await expect(own.getByRole('button')).toHaveCount(0);

    // The invite form asks for a phone number for caretakers and an email for everyone else.
    await ready(page, 'Invite someone');
    await page.getByRole('button', { name: 'Invite someone' }).click();
    const invite = page.getByRole('form', { name: 'Invite someone' });
    await expect(invite.getByLabel('Email address')).toBeVisible();
    await invite.getByLabel('Role').selectOption('caretaker');
    await expect(invite.getByLabel('Phone number')).toBeVisible();
    await expect(invite.getByLabel('Email address')).toHaveCount(0);
    await invite.getByRole('button', { name: 'Cancel' }).click();
  });

  test('a property manager sees the list but cannot manage it', async ({ page }) => {
    await signIn(page, PEOPLE.managerOne.email);
    await nav(page).getByRole('link', { name: 'Users and roles' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Users and roles');

    await expect(
      page.getByTestId('membership-row').filter({ hasText: PEOPLE.agencyAdmin.name }),
    ).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Invite someone' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Change|Remove) / })).toHaveCount(0);

    // The API refuses regardless of what the screen offers.
    const refused = await page.request.post('/api/v1/memberships', {
      data: {
        name: 'Should Not Exist',
        email: `refused.${unique().toLowerCase()}@demo.invalid`,
        role: 'adviser',
      },
    });
    expect(refused.status()).toBe(403);
  });
});
