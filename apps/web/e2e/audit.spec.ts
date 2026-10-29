import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';

test.describe('AD-07 audit search', () => {
  test('a branding change appears as company.update with the values before and after', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    await nav(page).getByRole('link', { name: 'Company settings' }).click();
    await ready(page, 'Save branding');

    const senderName = page.getByLabel('Sender name');
    const before = await senderName.inputValue();
    const after = `Audit check ${unique()}`;
    await senderName.fill(after);
    await page.getByRole('button', { name: 'Save branding' }).click();
    await expect(page.getByText('Branding saved.')).toBeVisible();

    await nav(page).getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Audit log');
    await ready(page, 'Search');
    await page.getByLabel('Action').fill('company.update');
    await page.getByLabel('Record type').fill('company');
    await page.getByRole('button', { name: 'Search' }).click();

    const latest = page.getByTestId('audit-event').first();
    await expect(latest).toContainText('company.update');
    await expect(latest).toContainText(PEOPLE.agencyAdmin.name);
    await expect(latest).toContainText(/\(Africa\/Accra\)/);
    const change = latest.getByRole('row', { name: /Sender name/ });
    await expect(change.getByRole('cell').nth(0)).toHaveText(before);
    await expect(change.getByRole('cell').nth(1)).toHaveText(after);
  });
});
