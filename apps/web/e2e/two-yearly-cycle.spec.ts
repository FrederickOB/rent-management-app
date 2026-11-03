import { expect, test } from '@playwright/test';
import { leaseIdByUnit } from './billing-helpers';
import { PEOPLE, ready, signIn, unique } from './helpers';
import { monthsFromToday, newPropertyWithUnits, newTenant } from './tenancy-helpers';

/**
 * M4b decision 9: rent in Ghana is paid monthly, twice a year, yearly and two years ahead, so
 * the lease forms offer a two-yearly cycle. Rent periods stay monthly whatever the cycle; the
 * invoice bundles 24 of them. Under the company's default advance policy (`off`, D6) nothing
 * warns about it.
 */
/** The seed's two-yearly lease: Ama Tenant's flat, GH₵1,600.00 a month, paid two years ahead by card. */
const TWO_YEARLY = { unit: 'ACC-ELG-B1-06', rent: 'GH₵1,600.00 a month, billed every two years' };

test.describe('M4b decision 9 the two-yearly rent cycle', () => {
  test('the seed’s lease billed every two years reads so, and was paid two years ahead by card', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const leaseId = await leaseIdByUnit(page, TWO_YEARLY.unit);
    await page.goto(`/leases/${leaseId}`);
    await expect(page.getByTestId('lease-terms')).toContainText('Every two years');
    await expect(page.getByTestId('lease-payments').getByTestId('lease-payment')).toContainText([
      'Card',
    ]);
    await page.goto('/leases');
    await page.getByLabel('Search').fill(TWO_YEARLY.unit);
    await expect(page.getByText(TWO_YEARLY.rent)).toBeVisible();
  });

  test('a manager drafts a two-year lease billed every two years; its page and the lease list say so', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Kwaku TwoYear ${tag} (e2e)`;
    await signIn(page, PEOPLE.managerOne.email);
    const { units } = await newPropertyWithUnits(page, 1);
    const unit = units[0]!;
    const tenant = await newTenant(page, name);

    await page.goto(`/leases/new?unitId=${unit.id}&tenantId=${tenant.id}`);
    await ready(page, 'Save as a draft');
    const form = page.getByRole('form', { name: 'New lease' });
    const cycle = form.getByLabel('Billing cycle');
    // Every cycle the founder named, in words, with quarterly kept for leases that use it.
    await expect(cycle.locator('option')).toHaveText([
      'Monthly',
      'Quarterly',
      'Every six months',
      'Annually',
      'Every two years',
    ]);

    await form.getByLabel('First day of the lease').fill(monthsFromToday(1));
    // A one-year term cannot carry a two-year cycle: the domain answers before the API is asked.
    await form.getByRole('button', { name: '1 year' }).click();
    await form.getByLabel('Monthly rent (GH₵)').fill('900');
    await cycle.selectOption({ label: 'Every two years' });
    await form.getByRole('button', { name: 'Save as a draft' }).click();
    await expect(form.getByText(/longer than the lease/)).toBeVisible();

    await form.getByRole('button', { name: '2 years' }).click();
    await expect(form.getByTestId('projected-schedule')).toContainText('(24 periods)');
    await form.getByRole('button', { name: 'Save as a draft' }).click();
    await expect(page).toHaveURL(/\/leases\/[0-9a-f-]{36}\?saved=draft$/);
    await expect(page.getByTestId('lease-terms')).toContainText('Every two years');

    await page.goto('/leases');
    await page.getByLabel('Search').fill(unit.code);
    await expect(page.getByText('GH₵900.00 a month, billed every two years')).toBeVisible();
  });
});
