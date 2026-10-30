import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn } from './helpers';
import { freePropertyPart, OWNER_A } from './register-helpers';

const twoDigits = (n: number) => String(n).padStart(2, '0');

test.describe('PR-01 bulk creation', () => {
  test('a manager sets up a 12-room compound house in one bulk step, then edits one unit', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    await nav(page).getByRole('link', { name: 'Portfolio' }).click();
    await page.getByRole('link', { name: 'New property' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('New property');
    await ready(page, 'Continue');

    // A fresh code each run: codes are never reused, and this database persists.
    const part = await freePropertyPart(page, 'ACC');
    const code = `ACC-${part}`;
    const name = `Legon compound house ${part} (e2e)`;

    // Step 1: details. The property type suggests the use, and the town the area code.
    await page.getByLabel('Property name').fill(name);
    await page.getByLabel('Property type').selectOption({ label: 'Compound house' });
    await expect(page.getByLabel('Use')).toHaveValue('residential');
    await page.getByLabel('Owner').selectOption({ label: OWNER_A.option });
    await page.getByLabel('Town or locality').fill('Accra');
    await expect(page.getByLabel('Area code')).toHaveValue('ACC');
    await page.getByLabel('Property part').fill(part);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 2: address, typed by hand.
    await expect(page.getByRole('heading', { name: 'Step 2 of 4: Address' })).toBeFocused();
    await page.getByLabel('Region').selectOption('Greater Accra');
    await page.getByLabel('Street or landmark').fill('Behind the e2e junction');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 3: the whole house in one bulk step, 6 single rooms then 6 chamber and hall.
    await expect(
      page.getByRole('heading', { name: 'Step 3 of 4: Blocks and units' }),
    ).toBeVisible();
    const first = page.getByRole('group', { name: 'Group 1' });
    await expect(first.getByLabel('Unit type')).toHaveValue('single_room');
    await first.getByLabel('How many').fill('6');
    await page.getByRole('button', { name: 'Add another group' }).click();
    const second = page.getByRole('group', { name: 'Group 2' });
    await second.getByLabel('Unit type').selectOption({ label: 'Chamber and hall' });
    await second.getByLabel('How many').fill('6');
    await expect(page.getByTestId('unit-total')).toHaveText('12 units');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 4: the codes are shown before anything is created.
    await expect(page.getByTestId('preview-total')).toHaveText('12');
    await expect(page.getByTestId('preview-range')).toHaveText(`${code}-B1-01 to ${code}-B1-12`);
    await page.getByRole('button', { name: 'Create property' }).click();

    // The property page lists every unit with its code.
    await expect(page).toHaveURL(/\/portfolio\/properties\/[0-9a-f-]{36}(\?created=1)?$/);
    const propertyUrl = page.url().replace(/\?.*$/, '');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByText(`Created ${code} with 12 units.`)).toBeVisible();
    // The notice is for arriving from the wizard: the address loses its marker.
    await expect(page).toHaveURL(/\/portfolio\/properties\/[0-9a-f-]{36}$/);
    const tiles = page.getByTestId('unit-tile');
    await expect(tiles).toHaveCount(12);
    for (let n = 1; n <= 12; n += 1) {
      const tile = tiles.nth(n - 1);
      await expect(tile).toContainText(`${code}-B1-${twoDigits(n)}`);
      await expect(tile).toContainText(n <= 6 ? 'Single room' : 'Chamber and hall');
      await expect(tile).toContainText('Vacant');
    }

    // Then unit by unit: give one room a floor and an amenity.
    await tiles.filter({ hasText: `${code}-B1-07` }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${code}-B1-07`);
    await ready(page, 'Edit unit');
    await page.getByRole('button', { name: 'Edit unit' }).click();
    const form = page.getByRole('form', { name: `Edit ${code}-B1-07` });
    await form.getByLabel('Floor (optional)').fill('Ground');
    await form.getByLabel('Borehole').check();
    await form.getByRole('button', { name: 'Save unit' }).click();
    await expect(page.getByText(`Saved ${code}-B1-07.`)).toBeVisible();

    await page.reload();
    const details = page.getByTestId('unit-details');
    await expect(details).toContainText('Ground');
    await expect(details).toContainText('Borehole');
    // Its neighbour is untouched.
    await page.goto(propertyUrl);
    await tiles.filter({ hasText: `${code}-B1-08` }).click();
    await expect(page.getByTestId('unit-details')).not.toContainText('Borehole');

    // Archive the test property, so repeated runs do not fill the demo portfolio. Its codes
    // stay taken.
    await page.goto(propertyUrl);
    await ready(page, 'Archive');
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await page
      .getByRole('group', { name: `Confirm archiving ${code}` })
      .getByRole('button', { name: 'Archive property' })
      .click();
    await expect(page).toHaveURL(/\/portfolio\?tab=properties$/);
    await expect(page.getByTestId('property-row').first()).toBeVisible();
    await expect(page.getByTestId('property-row').filter({ hasText: code })).toHaveCount(0);
  });
});
