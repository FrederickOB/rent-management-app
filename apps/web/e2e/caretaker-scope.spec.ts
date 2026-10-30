import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import {
  CARETAKER_LEGON,
  fixture,
  newSmsCode,
  propertyByCode,
  removeFiles,
  smsIds,
  uploadOnPropertyPage,
} from './register-helpers';

/** Another 6-digit code, so a wrong attempt never matches by chance. */
const notThe = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

test.describe('AD-06 caretaker phone sign-in, and AD-02 caretaker scope', () => {
  test('a caretaker signs in with a code sent to their phone, then sees only the property assigned to them, with its photos but not its papers', async ({
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const photo = `Compound yard ${tag}`;
    const plan = `Site plan ${tag}`;
    const staff = await browser.newContext({ baseURL });
    const field = await browser.newContext({ baseURL });
    const manager = await staff.newPage();
    let legonId: string | null = null;
    try {
      // The agency files a photo and a site plan for the Legon compound house.
      await signIn(manager, PEOPLE.managerOne.email);
      const legon = await propertyByCode(manager, 'ACC-LEG');
      const osu = await propertyByCode(manager, 'ACC-OSU'); // another caretaker's
      legonId = legon.id;
      await manager.goto(`/portfolio/properties/${legon.id}`);
      await ready(manager, 'Upload');
      await uploadOnPropertyPage(manager, {
        kind: 'Photo',
        caption: photo,
        path: fixture('property-photo.jpg'),
      });
      await uploadOnPropertyPage(manager, {
        kind: 'Site plan',
        caption: plan,
        path: fixture('title-deed.pdf'),
      });
      await expect(manager.getByRole('img', { name: photo })).toBeVisible({ timeout: 30_000 });
      const files = (await (
        await manager.request.get(`/api/v1/properties/${legon.id}/files`)
      ).json()) as { id: string; caption: string | null }[];
      const planId = files.find((f) => f.caption === plan)?.id;
      expect(planId, 'the site plan is on the list for the manager').toBeTruthy();

      // Kojo looks after Legon only. He signs in to the web with a code sent to his phone (one
      // code per run: the API sends at most 3 per phone in 15 minutes).
      const caretaker = await field.newPage();
      await caretaker.goto('/sign-in');
      await caretaker.getByRole('link', { name: 'Caretaker? Sign in with your phone' }).click();
      await expect(caretaker).toHaveURL(/\/sign-in\/phone$/);
      await ready(caretaker, 'Send code');
      // Something that is not a phone number is caught before any code is sent.
      await caretaker.getByLabel('Phone number').fill('12');
      await caretaker.getByRole('button', { name: 'Send code' }).click();
      await expect(
        caretaker.getByRole('alert').filter({ hasText: 'Enter your phone number' }),
      ).toBeVisible();
      // He types it the way it is written in Ghana; the form sends it as +233…
      const seen = await smsIds(caretaker.request, CARETAKER_LEGON.phone);
      await caretaker.getByLabel('Phone number').fill('020 000 0011');
      await caretaker.getByRole('button', { name: 'Send code' }).click();
      await expect(caretaker.getByLabel('6-digit code')).toBeVisible();
      const code = await newSmsCode(caretaker.request, CARETAKER_LEGON.phone, seen);
      // A wrong code is refused in plain words; the right one still works afterwards.
      await caretaker.getByLabel('6-digit code').fill(notThe(code));
      await caretaker.getByRole('button', { name: 'Sign in' }).click();
      await expect(
        caretaker.getByRole('alert').filter({ hasText: 'That code is not right' }),
      ).toBeVisible();
      await caretaker.getByLabel('6-digit code').fill(code);
      await caretaker.getByRole('button', { name: 'Sign in' }).click();
      await expect(caretaker.getByTestId('app-header')).toBeVisible();
      await expect(caretaker).toHaveURL(/\/$/);
      await expect(caretaker.getByTestId('shell-person')).toHaveText(CARETAKER_LEGON.name);
      await expect(nav(caretaker).getByRole('link', { name: 'Portfolio' })).toBeVisible();
      await expect(nav(caretaker).getByRole('link', { name: 'Owners' })).toHaveCount(0);
      await expect(nav(caretaker).getByRole('link', { name: 'Import' })).toHaveCount(0);

      // Every unit he sees is in Legon, and the counts cover only those.
      await nav(caretaker).getByRole('link', { name: 'Portfolio' }).click();
      const rows = caretaker.getByTestId('unit-row');
      await expect(rows.filter({ hasText: 'ACC-LEG-B1-01' })).toHaveCount(1);
      const total = Number(
        await caretaker.getByTestId('status-chip-all').getByTestId('chip-count').textContent(),
      );
      await expect(rows).toHaveCount(total);
      await expect(rows.filter({ hasText: 'ACC-LEG-' })).toHaveCount(total);
      await caretaker.getByRole('tab', { name: 'Properties' }).click();
      await expect(caretaker.getByTestId('property-row')).toHaveCount(1);
      await expect(caretaker.getByTestId('property-row')).toContainText('ACC-LEG');
      await expect(caretaker.getByRole('link', { name: 'New property' })).toHaveCount(0);

      // On the property page: the photo, but no papers and no way to change anything.
      await caretaker.getByTestId('property-row').getByRole('link').click();
      await expect(caretaker.getByRole('heading', { level: 1 })).toHaveText(legon.name);
      await expect(caretaker.getByRole('heading', { name: 'Photos', exact: true })).toBeVisible();
      await expect(caretaker.getByRole('heading', { name: 'Photos and papers' })).toHaveCount(0);
      await expect(caretaker.getByRole('img', { name: photo })).toBeVisible();
      await expect(caretaker.getByRole('heading', { name: 'Papers' })).toHaveCount(0);
      await expect(caretaker.getByTestId('paper')).toHaveCount(0);
      await expect(caretaker.getByText(plan)).toHaveCount(0);
      await expect(caretaker.getByRole('form', { name: 'Upload a photo or paper' })).toHaveCount(0);
      await expect(caretaker.getByRole('button', { name: 'Edit details' })).toHaveCount(0);

      // The API agrees: the list holds photos only, and the plan's link is refused.
      const listed = (await (
        await caretaker.request.get(`/api/v1/properties/${legon.id}/files`)
      ).json()) as { category: string; caption: string | null }[];
      expect(listed.some((f) => f.caption === photo)).toBe(true);
      expect(listed.every((f) => f.category === 'photo')).toBe(true);
      expect(
        (await caretaker.request.get(`/api/v1/property-files/${planId}/download`)).status(),
      ).toBe(403);

      // Another caretaker's property does not exist for him.
      await caretaker.goto(`/portfolio/properties/${osu.id}`);
      await expect(caretaker.getByRole('heading', { level: 1 })).toHaveText('Page not found');
      await expect(caretaker.getByText(osu.name)).toHaveCount(0);
    } finally {
      if (legonId) await removeFiles(manager, legonId, tag);
      await staff.close();
      await field.close();
    }
  });
});
