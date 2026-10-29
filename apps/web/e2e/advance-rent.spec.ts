import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import { monthsFromToday, newPropertyWithUnits, newTenant } from './tenancy-helpers';

test.describe('AR-05 advance rent check', () => {
  test('under “warn”, a lease asking for more months in advance than the rule allows is flagged, never called compliant', async ({
    page,
  }) => {
    const tag = unique();
    const name = `Kwabena Advance ${tag} (e2e)`;
    await signIn(page, PEOPLE.agencyAdmin.email);
    const before = (await (await page.request.get('/api/v1/company')).json()) as {
      settings: { advanceRentPolicy: 'off' | 'warn' | 'block' };
    };
    const original = before.settings.advanceRentPolicy;
    try {
      // The agency switches the check to "warn" on its settings screen.
      await nav(page).getByRole('link', { name: 'Company settings' }).click();
      await ready(page, 'Save settings');
      await page.getByLabel('Advance rent over the limit').selectOption({ label: 'Warn' });
      await page.getByRole('button', { name: 'Save settings' }).click();
      await expect(page.getByText('Settings saved.')).toBeVisible();

      // A 12-month lease asking for 12 months up front, against the 6-month rule for long terms.
      const { units } = await newPropertyWithUnits(page, 1);
      const tenant = await newTenant(page, name);
      await page.goto(`/leases/new?unitId=${units[0]!.id}&tenantId=${tenant.id}`);
      await ready(page, 'Save as a draft');
      const form = page.getByRole('form', { name: 'New lease' });
      await form.getByLabel('First day of the lease').fill(monthsFromToday(1));
      await form.getByRole('button', { name: '1 year' }).click();
      await form.getByLabel('Monthly rent (GH₵)').fill('900');
      await form.getByLabel('Initial advance in months (optional)').fill('12');
      await form.getByRole('button', { name: 'Save as a draft' }).click();
      await expect(page).toHaveURL(/\/leases\/[0-9a-f-]{36}\?saved=draft$/);

      const flag = page.getByRole('status').filter({ hasText: 'Advance rent over the limit' });
      await expect(flag).toContainText('These terms ask for 12 months’ rent in advance');
      await expect(flag).toContainText('the limit for a lease of this length is 6 months');
      await expect(flag).toContainText('Act 220 s.25(5)');
      await expect(flag).toContainText('not yet verified by counsel');
      await expect(page.getByText(/compliant/i)).toHaveCount(0);

      // The lease list flags it too.
      await nav(page).getByRole('link', { name: 'Leases' }).click();
      await page.getByLabel('Search').fill(units[0]!.code);
      await expect(page.getByTestId('lease-row').filter({ hasText: units[0]!.code })).toContainText(
        'Advance over the limit',
      );
    } finally {
      // Always put the agency's policy back, whatever happened above.
      const restored = await page.request.patch('/api/v1/company/settings', {
        data: { advanceRentPolicy: original },
      });
      expect(restored.status(), 'restore the advance rent policy').toBe(200);
    }
    const after = (await (await page.request.get('/api/v1/company')).json()) as {
      settings: { advanceRentPolicy: string };
    };
    expect(after.settings.advanceRentPolicy).toBe(original);
  });
});
