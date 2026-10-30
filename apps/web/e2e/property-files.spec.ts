import { expect, test } from '@playwright/test';
import { PEOPLE, ready, signIn, unique } from './helpers';
import {
  expectNoSidewaysScroll,
  fixture,
  OWNER_A,
  propertyByCode,
  removeFiles,
  uploadOnPropertyPage,
} from './register-helpers';

// A 5-inch phone screen (PRD section 5: an owner abroad checks the papers on a phone).
const PHONE = { width: 360, height: 640 };

test.describe('PR-04 photos and papers on a phone, and AD-02 owner scope', () => {
  test('a client owner opens her property’s photos and papers on a phone, and not another owner’s property', async ({
    browser,
    baseURL,
  }) => {
    const tag = unique();
    const photo = `Front of the flats ${tag}`;
    const paper = `Indenture ${tag}`;
    const staff = await browser.newContext({ baseURL });
    const phone = await browser.newContext({ baseURL, viewport: PHONE });
    const manager = await staff.newPage();
    let propertyId: string | null = null;
    try {
      // The agency files a photo and the indenture for Owner A's flats in East Legon.
      await signIn(manager, PEOPLE.managerOne.email);
      const flats = await propertyByCode(manager, 'ACC-ELG');
      const other = await propertyByCode(manager, 'ACC-OSU'); // Owner B's
      propertyId = flats.id;
      await manager.goto(`/portfolio/properties/${flats.id}`);
      await ready(manager, 'Upload');
      await uploadOnPropertyPage(manager, {
        kind: 'Photo',
        caption: photo,
        path: fixture('property-photo.jpg'),
      });
      await uploadOnPropertyPage(manager, {
        kind: 'Title or indenture',
        caption: paper,
        path: fixture('title-deed.pdf'),
      });
      // The worker re-encodes the photo without its location data; the page shows it when ready.
      await expect(manager.getByRole('img', { name: photo })).toBeVisible({ timeout: 30_000 });

      // Owner A, abroad, on her phone.
      const owner = await phone.newPage();
      await signIn(owner, OWNER_A.email);
      await owner.goto('/portfolio?tab=properties');
      await owner
        .getByTestId('property-row')
        .filter({ hasText: 'ACC-ELG' })
        .getByRole('link')
        .click();
      await expect(owner.getByRole('heading', { level: 1 })).toHaveText(flats.name);
      await expect(owner.getByRole('heading', { name: 'Photos and papers' })).toBeVisible();

      const thumbnail = owner.getByRole('img', { name: photo });
      await expect(thumbnail).toBeVisible();
      await expect
        .poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(0);
      const papers = owner.getByTestId('paper').filter({ hasText: paper });
      await expect(papers).toContainText('Title or indenture');
      // She can read the register but not change it.
      await expect(owner.getByRole('form', { name: 'Upload a photo or paper' })).toHaveCount(0);
      await expect(owner.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
      await expectNoSidewaysScroll(owner);

      // Each file opens through a fresh, short-lived link issued after the policy check.
      await ready(owner, `Open ${paper}`);
      const issued = owner.waitForResponse(
        (r) => /\/api\/v1\/property-files\/[^/]+\/download/.test(r.url()) && r.status() === 200,
      );
      const opened = owner.waitForEvent('popup');
      await owner.getByRole('button', { name: `Open ${paper}` }).click();
      const { url } = (await (await issued).json()) as { url: string };
      (await opened).close().catch(() => undefined);
      const download = await owner.request.get(url);
      expect(download.status()).toBe(200);
      expect(download.headers()['content-type']).toContain('application/pdf');
      expect((await download.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

      // Another owner's property is not there at all: not in her list, and not by its address.
      await owner.goto('/portfolio?tab=properties');
      await expect(owner.getByTestId('property-row').filter({ hasText: 'ACC-ELG' })).toHaveCount(1);
      await expect(owner.getByTestId('property-row').filter({ hasText: 'ACC-OSU' })).toHaveCount(0);
      await owner.goto(`/portfolio/properties/${other.id}`);
      await expect(owner.getByRole('heading', { level: 1 })).toHaveText('Page not found');
      await expect(owner.getByText(other.name)).toHaveCount(0);
      await expectNoSidewaysScroll(owner);
      // The API refuses its files the same way, whatever the screen shows.
      expect((await owner.request.get(`/api/v1/properties/${other.id}/files`)).status()).toBe(404);
    } finally {
      if (propertyId) await removeFiles(manager, propertyId, tag);
      await staff.close();
      await phone.close();
    }
  });
});
