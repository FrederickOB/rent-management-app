import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';

test.describe('M3 plan 4.13 owner tax fields', () => {
  test('the agency admin records an owner’s letting business, VAT registration and TIN; the TIN shows masked and is revealed with a reason', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Kwaku Tax ${tag} (e2e)`;
    const tin = `C00${String(Math.trunc(Math.random() * 100_000_000)).padStart(8, '0')}`;
    await signIn(page, PEOPLE.agencyAdmin.email);
    await nav(page).getByRole('link', { name: 'Owners' }).click();
    await ready(page, 'Add an owner');
    await page.getByRole('button', { name: 'Add an owner' }).click();
    const add = page.getByRole('form', { name: 'Add owner' });
    await add.getByLabel('Name', { exact: true }).fill(name);
    await add.getByLabel('Lets property as a business').check();
    await add.getByLabel('Registered for VAT').check();
    await add.getByLabel('TIN (optional)').fill('abc');
    await add.getByRole('button', { name: 'Add owner' }).click();
    await expect(add.getByText('Enter the TIN: 6 to 20 letters, digits or hyphens')).toBeVisible();
    await add.getByLabel('TIN (optional)').fill(tin.toLowerCase());
    await add.getByRole('button', { name: 'Add owner' }).click();
    await expect(page.getByText(`Added ${name} as OWN-`)).toBeVisible();

    const row = page.getByTestId('owner-row').filter({ hasText: name });
    const tax = row.getByTestId('owner-tax');
    await expect(tax).toContainText('Lets property as a business');
    await expect(tax).toContainText('VAT registered');
    await expect(tax).toContainText(`TIN *******${tin.slice(-4)}`);
    await expect(page.getByText(tin)).toHaveCount(0);

    await row.getByRole('button', { name: `Show the TIN of ${name}` }).click();
    const reveal = row.getByRole('form', { name: `Show the TIN of ${name}` });
    await reveal.getByLabel('Reason').fill(`Filing the owner’s rent tax return ${tag}`);
    await reveal.getByRole('button', { name: 'Show the TIN' }).click();
    await expect(row.getByText(tin)).toBeVisible();
    await row.getByRole('button', { name: 'Hide' }).click();
    await expect(page.getByText(tin)).toHaveCount(0);

    // The reveal is in the audit log with its reason; the number is not.
    await nav(page).getByRole('link', { name: 'Audit log' }).click();
    await ready(page, 'Search');
    await page.getByLabel('Action').fill('tin.revealed');
    await page.getByRole('button', { name: 'Search' }).click();
    const latest = page.getByTestId('audit-event').first();
    await expect(latest).toContainText('tin.revealed');
    await expect(latest).toContainText(`Filing the owner’s rent tax return ${tag}`);
    await expect(page.getByText(tin)).toHaveCount(0);

    // Not a letting business any more; the record stays, archived.
    await nav(page).getByRole('link', { name: 'Owners' }).click();
    await row.getByRole('button', { name: `Edit ${name}` }).click();
    const edit = row.getByRole('form', { name: 'Save owner' });
    await expect(edit.getByLabel(/^TIN \(on file: /)).toHaveValue('');
    await edit.getByLabel('Lets property as a business').uncheck();
    await edit.getByRole('button', { name: 'Save owner' }).click();
    await expect(page.getByText(`Saved ${name}.`)).toBeVisible();
    await expect(tax).toContainText('Not a letting business');
    await expect(tax).toContainText(`TIN *******${tin.slice(-4)}`);
    await row.getByRole('button', { name: `Archive ${name}` }).click();
    await page
      .getByRole('group', { name: `Confirm archiving ${name}` })
      .getByRole('button', { name: 'Archive owner' })
      .click();
    await expect(page.getByText(`Archived ${name}.`)).toBeVisible();
  });
});
