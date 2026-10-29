import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn } from './helpers';
import { newSmsCode, smsIds } from './register-helpers';

/** Abena looks after ACC-OSU only (the seed); the pharmacy rents ACC-OSU-G-01 there. */
const CARETAKER_OSU = { phone: '+233200000012', name: 'Abena Caretaker (demo)' };
const PHARMACY = 'Osu Pharmacy Ltd (demo)';
const LEGON_TENANT = 'Kwame Monthly (demo)'; // rents ACC-LEG-B1-01, outside her scope

test.describe('TL-01 and plan 4.14 the caretaker view of tenants', () => {
  test('a caretaker sees only the name, phone and unit of the tenants on her property, and no one else', async ({
    browser,
    baseURL,
  }) => {
    const staff = await browser.newContext({ baseURL });
    const field = await browser.newContext({ baseURL });
    try {
      // A manager finds the ids the caretaker should and should not reach.
      const manager = await staff.newPage();
      await signIn(manager, PEOPLE.managerOne.email);
      const tenants = (await (await manager.request.get('/api/v1/tenants')).json()) as {
        id: string;
        displayName: string;
        email?: string | null;
      }[];
      const pharmacy = tenants.find((t) => t.displayName === PHARMACY);
      const legon = tenants.find((t) => t.displayName === LEGON_TENANT);
      expect(pharmacy?.email, 'the seed gives the pharmacy an email').toBeTruthy();
      expect(legon, 'the seed has the Legon tenant').toBeTruthy();

      // One phone code per run: the API sends at most 3 per phone in 15 minutes.
      const caretaker = await field.newPage();
      await caretaker.goto('/sign-in/phone');
      await ready(caretaker, 'Send code');
      const seen = await smsIds(caretaker.request, CARETAKER_OSU.phone);
      await caretaker.getByLabel('Phone number').fill('020 000 0012');
      await caretaker.getByRole('button', { name: 'Send code' }).click();
      await expect(caretaker.getByLabel('6-digit code')).toBeVisible();
      const code = await newSmsCode(caretaker.request, CARETAKER_OSU.phone, seen);
      await caretaker.getByLabel('6-digit code').fill(code);
      await caretaker.getByRole('button', { name: 'Sign in' }).click();
      await expect(caretaker.getByTestId('shell-person')).toHaveText(CARETAKER_OSU.name);

      // The list: names, phones and units, without ID checks or consent, and no way to add one.
      await nav(caretaker).getByRole('link', { name: 'Tenants' }).click();
      await expect(caretaker.getByRole('heading', { level: 1 })).toHaveText('Tenants');
      const rows = caretaker.getByTestId('tenant-row');
      await expect(rows.filter({ hasText: PHARMACY })).toContainText('ACC-OSU-G-01');
      await expect(rows.filter({ hasText: LEGON_TENANT })).toHaveCount(0);
      await expect(caretaker.getByRole('columnheader', { name: 'ID check' })).toHaveCount(0);
      await expect(caretaker.getByRole('link', { name: 'New tenant' })).toHaveCount(0);

      // The profile: the same three facts, nothing more.
      await rows.filter({ hasText: PHARMACY }).getByRole('link', { name: PHARMACY }).click();
      await expect(caretaker.getByRole('heading', { level: 1 })).toHaveText(PHARMACY);
      await expect(caretaker.getByTestId('tenant-limited')).toContainText('ACC-OSU-G-01');
      await expect(caretaker.getByText(pharmacy!.email!)).toHaveCount(0);
      for (const section of ['identity', 'contacts', 'consent', 'timeline'])
        await expect(caretaker.getByTestId(section)).toHaveCount(0);
      const limited = (await (
        await caretaker.request.get(`/api/v1/tenants/${pharmacy!.id}`)
      ).json()) as Record<string, unknown>;
      expect(limited).toMatchObject({ access: 'limited', displayName: PHARMACY });
      expect(Object.keys(limited).sort()).toEqual(
        ['access', 'displayName', 'id', 'kind', 'phone', 'units'].sort(),
      );

      // Leases: the unit and the dates only.
      await nav(caretaker).getByRole('link', { name: 'Leases' }).click();
      const lease = caretaker.getByTestId('lease-row').filter({ hasText: 'ACC-OSU-G-01' });
      await expect(lease).toHaveCount(1);
      await expect(lease).not.toContainText(PHARMACY);
      await expect(lease).not.toContainText('GH₵');
      await lease.getByRole('link', { name: 'ACC-OSU-G-01' }).click();
      await expect(caretaker.getByTestId('lease-limited')).toBeVisible();
      await expect(caretaker.getByTestId('lease-terms')).toHaveCount(0);

      // A tenant on another property does not exist for her.
      await caretaker.goto(`/tenants/${legon!.id}`);
      await expect(caretaker.getByRole('heading', { level: 1 })).toHaveText('Page not found');
      await expect(caretaker.getByText(LEGON_TENANT)).toHaveCount(0);
    } finally {
      await staff.close();
      await field.close();
    }
  });
});
