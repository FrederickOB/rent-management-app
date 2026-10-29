import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';

function randomColour(): { hex: string; rgb: string } {
  const channels = Array.from({ length: 3 }, () => Math.trunc(Math.random() * 256));
  const hex = `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  return { hex, rgb: `rgb(${channels.join(', ')})` };
}

test.describe('AD-01 company branding', () => {
  test('the agency admin changes the primary colour and sender name and sees them in the shell', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    await nav(page).getByRole('link', { name: 'Company settings' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Company settings');
    await ready(page, 'Save branding');

    const colour = randomColour();
    const sender = `Osu Ridge ${unique()}`;
    await page.getByLabel('Primary colour', { exact: true }).fill(colour.hex);
    await page.getByLabel('Sender name').fill(sender);
    await page.getByRole('button', { name: 'Save branding' }).click();
    await expect(page.getByText('Branding saved.')).toBeVisible();

    const header = page.getByTestId('app-header');
    await expect(page.getByTestId('shell-sender-name')).toHaveText(`Sender name: ${sender}`);
    await expect(header).toHaveCSS('background-color', colour.rgb);

    // Saved, not just shown: a fresh load shows the same branding.
    await page.reload();
    await expect(page.getByTestId('shell-sender-name')).toHaveText(`Sender name: ${sender}`);
    await expect(header).toHaveCSS('background-color', colour.rgb);
    await expect(page.getByLabel('Primary colour', { exact: true })).toHaveValue(colour.hex);
  });
});
