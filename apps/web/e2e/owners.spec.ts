import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import { OWNER_A, OWNER_B } from './register-helpers';

const ADVISER = 'Adjoa Adviser (demo)'; // the seed links her to Owner A

test.describe('AD-02 owner records', () => {
  test('the agency admin adds, edits and archives an owner, and sees what each owner owns', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    await nav(page).getByRole('link', { name: 'Owners' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Owners');
    await ready(page, 'Add an owner');

    // Owner A lives in London and owns the Legon and East Legon properties.
    const ownerA = page.getByTestId('owner-row').filter({ hasText: OWNER_A.name });
    await expect(ownerA).toContainText('Lives in United Kingdom (GB)');
    await expect(ownerA).toContainText('Europe/London');
    await ownerA.getByRole('button', { name: `Properties of ${OWNER_A.name}` }).click();
    await expect(ownerA.getByRole('link', { name: /ACC-LEG/ })).toBeVisible();
    await expect(ownerA.getByRole('link', { name: /ACC-ELG/ })).toBeVisible();
    await expect(ownerA.getByRole('link', { name: /ACC-OSU/ })).toHaveCount(0);

    // The people whose access runs through each owner: the client-owner users and the adviser.
    await expect(ownerA.getByTestId('linked-users')).toContainText(`${OWNER_A.name} (Owner)`);
    await expect(ownerA.getByTestId('linked-users')).toContainText(`${ADVISER} (Adviser)`);
    const ownerB = page.getByTestId('owner-row').filter({ hasText: OWNER_B.name });
    await expect(ownerB.getByTestId('linked-users')).toContainText(`${OWNER_B.name} (Owner)`);
    await expect(ownerB.getByTestId('linked-users')).not.toContainText(ADVISER);

    // A new client, living in Ghana; the API gives the next OWN reference.
    const name = `Kwame Owner ${unique()} (e2e)`;
    await page.getByRole('button', { name: 'Add an owner' }).click();
    const add = page.getByRole('form', { name: 'Add owner' });
    await add.getByLabel('Name', { exact: true }).fill(name);
    await add.getByLabel('Email (optional)').fill('not-an-email');
    await add.getByRole('button', { name: 'Add owner' }).click();
    await expect(add.getByText('Enter an email address such as owner@example.com')).toBeVisible();
    await add.getByLabel('Email (optional)').fill('kwame.owner@demo.invalid');
    await add.getByLabel('Country of residence (optional)').fill('gh');
    await add.getByRole('button', { name: 'Add owner' }).click();
    await expect(page.getByText(`Added ${name} as OWN-`)).toBeVisible();
    const row = page.getByTestId('owner-row').filter({ hasText: name });
    await expect(row).toContainText('Lives in Ghana (GH)');
    await expect(row).toContainText('Africa/Accra');
    await expect(row.getByTestId('linked-users')).toHaveText('No users linked');

    // Edit: the owner moves abroad.
    await row.getByRole('button', { name: `Edit ${name}` }).click();
    const edit = row.getByRole('form', { name: 'Save owner' });
    await edit.getByLabel('Country of residence (optional)').fill('GB');
    await edit.getByLabel('Time zone').fill('Europe/London');
    await edit.getByRole('button', { name: 'Save owner' }).click();
    await expect(page.getByText(`Saved ${name}.`)).toBeVisible();
    await expect(row).toContainText('Lives in United Kingdom (GB)');
    await expect(row).toContainText('Europe/London');

    // Archive, never delete: the record stays, out of the way.
    await row.getByRole('button', { name: `Archive ${name}` }).click();
    await page
      .getByRole('group', { name: `Confirm archiving ${name}` })
      .getByRole('button', { name: 'Archive owner' })
      .click();
    await expect(page.getByText(`Archived ${name}.`)).toBeVisible();
    await expect(page.getByTestId('owner-row').filter({ hasText: name })).toHaveCount(0);
    await page.getByLabel('Show archived owners').check();
    await expect(page.getByTestId('owner-row').filter({ hasText: name })).toContainText('Archived');
  });

  test('a manager sees the owners and who is linked to them, but cannot change them', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    await nav(page).getByRole('link', { name: 'Owners' }).click();
    const ownerA = page.getByTestId('owner-row').filter({ hasText: OWNER_A.name });
    await expect(ownerA).toHaveCount(1);
    await expect(ownerA.getByTestId('linked-users')).toContainText(`${ADVISER} (Adviser)`);
    await expect(page.getByRole('button', { name: 'Add an owner' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Edit|Archive) / })).toHaveCount(0);
  });

  test('an accountant sees the owners but not the people linked to them', async ({ page }) => {
    // Accountants may see owners (owner.view) but not list people (membership.view).
    await signIn(page, PEOPLE.accountant.email);
    await nav(page).getByRole('link', { name: 'Owners' }).click();
    await expect(page.getByTestId('owner-row').filter({ hasText: OWNER_A.name })).toHaveCount(1);
    await expect(page.getByTestId('linked-users')).toHaveCount(0);
    await expect(page.getByText('No users linked')).toHaveCount(0);
  });
});
