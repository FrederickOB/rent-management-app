import { expect, test, type Page } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import { OWNER_A, OWNER_B, unitByCode } from './register-helpers';

const chip = (page: Page, status: string) => page.getByTestId(`status-chip-${status}`);
const chipCount = async (page: Page, status: string) =>
  Number(await chip(page, status).getByTestId('chip-count').textContent());

test.describe('PRD section 5 and AD-02 status across owners', () => {
  test('the agency manager sees every owner’s units on one screen; the filters and counts follow', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    await nav(page).getByRole('link', { name: 'Portfolio' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Portfolio');
    const rows = page.getByTestId('unit-row');

    // Both of the agency's owners, side by side.
    await expect(rows.filter({ hasText: 'ACC-LEG-B1-01' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'ACC-OSU-G-01' })).toHaveCount(1);
    await expect(rows.filter({ hasText: OWNER_A.name }).first()).toBeVisible();
    await expect(rows.filter({ hasText: OWNER_B.name }).first()).toBeVisible();
    await expect(rows.filter({ hasText: 'ACC-LEG-B2-06' })).toContainText('Under repair');
    const everyone = await chipCount(page, 'all');

    // One owner: only her units, and the counts by status follow the filter.
    await page.getByLabel('Owner').selectOption({ label: OWNER_B.option });
    await expect(page).toHaveURL(/[?&]owner=/);
    await expect(rows.filter({ hasText: 'ACC-LEG-' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'ACC-OSU-G-01' })).toHaveCount(1);
    await expect(rows.filter({ hasText: OWNER_A.name })).toHaveCount(0);
    const hers = await chipCount(page, 'all');
    expect(hers).toBeLessThan(everyone);
    await expect(rows).toHaveCount(hers);
    for (const [status, label] of [
      ['vacant', 'Vacant'],
      ['not_lettable', 'Not lettable'],
      ['under_repair', 'Under repair'],
    ] as const)
      await expect(rows.filter({ has: page.getByText(label, { exact: true }) })).toHaveCount(
        await chipCount(page, status),
      );

    // Choosing a chip filters by status; the other chips keep their counts.
    const vacantBefore = await chipCount(page, 'vacant');
    await chip(page, 'not_lettable').click();
    await expect(chip(page, 'not_lettable')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/status=not_lettable/);
    await expect(rows.filter({ hasText: 'ACC-OSU-G-04' })).toHaveCount(1);
    await expect(rows).toHaveCount(await chipCount(page, 'not_lettable'));
    expect(await chipCount(page, 'vacant')).toBe(vacantBefore);

    // Unit type narrows further; clearing brings everything back.
    await chip(page, 'not_lettable').click();
    await page.getByLabel('Unit type').selectOption({ label: 'Office' });
    await expect(rows.filter({ hasText: 'ACC-OSU-F1-' })).toHaveCount(4);
    await expect(rows.filter({ hasText: 'ACC-OSU-G-' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/portfolio$/);
    await expect(chip(page, 'all').getByTestId('chip-count')).toHaveText(String(everyone));

    // The counts follow the data too: a shop goes under repair, and a refresh shows it.
    const shop = await unitByCode(page, 'ACC-OSU-G-03');
    const repairsBefore = await chipCount(page, 'under_repair');
    const reason = `Shutter repair ${unique()}`;
    try {
      const changed = await page.request.post(`/api/v1/units/${shop.id}/availability`, {
        data: { availability: 'under_repair', reason },
      });
      expect(changed.status()).toBe(200);
      await ready(page, 'Refresh');
      await page.getByRole('button', { name: 'Refresh' }).click();
      await expect(chip(page, 'under_repair').getByTestId('chip-count')).toHaveText(
        String(repairsBefore + 1),
      );
      await expect(rows.filter({ hasText: 'ACC-OSU-G-03' })).toContainText('Under repair');
    } finally {
      await page.request.post(`/api/v1/units/${shop.id}/availability`, {
        data: { availability: 'available', reason: `Done: ${reason}` },
      });
    }

    // The navigation starts the portfolio afresh, whatever was filtered.
    await page.getByLabel('Owner').selectOption({ label: OWNER_A.option });
    await expect(page).toHaveURL(/[?&]owner=/);
    await expect(rows.filter({ hasText: 'ACC-OSU-' })).toHaveCount(0);
    await nav(page).getByRole('link', { name: 'Portfolio' }).click();
    await expect(page).toHaveURL(/\/portfolio$/);
    await expect(page.getByLabel('Owner')).toHaveValue('');
    await expect(rows.filter({ hasText: 'ACC-OSU-G-01' })).toHaveCount(1);

    // The properties tab lists each property with its owner and counts.
    await page.getByRole('tab', { name: 'Properties' }).click();
    await expect(page).toHaveURL(/tab=properties/);
    const properties = page.getByTestId('property-row');
    await expect(properties.filter({ hasText: 'ACC-LEG' })).toContainText(OWNER_A.name);
    await expect(properties.filter({ hasText: 'ACC-OSU' })).toContainText(OWNER_B.name);
    await expect(properties.filter({ hasText: 'ACC-OSU' })).toContainText('1 not lettable');
  });
});
