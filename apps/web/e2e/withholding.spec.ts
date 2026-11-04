import { expect, test } from '@playwright/test';
import { leaseIdByUnit } from './billing-helpers';
import { PEOPLE, signIn } from './helpers';
import { OWNER_B } from './register-helpers';
import { apiGet, cedis, myPersonId } from './tax-helpers';

/**
 * TX-04 on the lease page (M5 plan 5.2 and 5.8, decision 3). In the seed, Osu Pharmacy Ltd, the
 * commercial company tenant of ACC-OSU-G-01 (Nana Owner-Accra's Osu building), withholds tax:
 * one certificate is confirmed and one waits for a landlord user. A manager uploaded it; the
 * uploader is never offered to confirm it, and Nana, a user for the owner, confirms it.
 */
const UNIT = 'ACC-OSU-G-01';

interface Withholding {
  readonly id: string;
  readonly amountMinor: number;
  readonly status: string;
  readonly certificate: { readonly id: string; readonly uploadedBy: string } | null;
}

test.describe('TX-04 withholding tax and its certificate', () => {
  test('the lease shows each withholding and its certificate; the uploader is never offered to confirm it, and a user for the owner confirms it', async ({
    browser,
    baseURL,
  }) => {
    const staff = await browser.newContext({ baseURL });
    const owner = await browser.newContext({ baseURL });
    try {
      const manager = await staff.newPage();
      await signIn(manager, PEOPLE.managerTwo.email);
      const leaseId = await leaseIdByUnit(manager, UNIT);
      const records = await apiGet<Withholding[]>(
        manager.request,
        `/withholding?leaseId=${leaseId}`,
      );
      const confirmed = records.find((r) => r.status === 'certified');
      const waiting = records.find((r) => r.status === 'certificate_uploaded');
      expect(confirmed, 'a confirmed certificate: run pnpm db:seed').toBeTruthy();
      expect(waiting, 'a certificate waiting for confirmation: run pnpm db:seed').toBeTruthy();

      await manager.goto(`/leases/${leaseId}`);
      const card = manager.getByTestId('withholding');
      const done = card.locator(`[data-withholding-id="${confirmed!.id}"]`);
      await expect(done.getByTestId('withholding-status')).toHaveText('Certificate confirmed');
      await expect(done).toContainText(cedis(confirmed!.amountMinor));
      await expect(done.getByRole('button', { name: 'Open the certificate' })).toBeVisible();

      // A manager is never offered the confirmation: their own upload, or not a user for the owner.
      const pending = card.locator(`[data-withholding-id="${waiting!.id}"]`);
      await expect(pending.getByTestId('withholding-status')).toHaveText(
        'Certificate uploaded, waiting for a landlord user to confirm it',
      );
      await expect(pending.getByRole('button', { name: 'Confirm the certificate' })).toHaveCount(0);
      await expect(pending.getByTestId('confirm-blocked')).toHaveText(
        waiting!.certificate!.uploadedBy === (await myPersonId(manager))
          ? 'You uploaded this certificate, so another landlord user must confirm it.'
          : 'A user for the owner confirms the certificate, or an agency admin where the owner has none.',
      );
      // The API refuses it as well, whatever the screen offers.
      const refused = await manager.request.post(
        `/api/v1/withholding-certificates/${waiting!.certificate!.id}/confirm`,
        { data: {} },
      );
      expect(refused.status()).toBe(403);

      // Nana is a user for the owner, and did not upload it: she confirms it.
      const nana = await owner.newPage();
      await signIn(nana, OWNER_B.email);
      expect(waiting!.certificate!.uploadedBy).not.toBe(await myPersonId(nana));
      await nana.goto(`/leases/${leaseId}`);
      const hers = nana
        .getByTestId('withholding')
        .locator(`[data-withholding-id="${waiting!.id}"]`);
      await hers.getByRole('button', { name: 'Confirm the certificate' }).click();
      await expect(
        nana.getByText(`Confirmed the certificate for ${cedis(waiting!.amountMinor)}.`),
      ).toBeVisible();
      await expect(hers.getByTestId('withholding-status')).toHaveText('Certificate confirmed');
      await expect(hers).toContainText('settles the owner’s rent tax on these lines');
      const after = await apiGet<Withholding>(nana.request, `/withholding/${waiting!.id}`);
      expect(after.status).toBe('certified');
    } finally {
      await staff.close();
      await owner.close();
    }
  });
});
