import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import { fixture, OWNER_B } from './register-helpers';
import { apiGet, cedis, monthOf, ownerIdByName } from './tax-helpers';

/**
 * P32 and P33 on the VAT returns screen (M5 plan 5.6 and 5.8). Nana Owner-Accra (OWN-02) is
 * registered for VAT, and her Osu building's commercial tenant is billed VAT, NHIL and GETFund
 * (M4a). The seed records one VAT payment for her. The rates' rules are unverified (OQ-20).
 */
interface VatPayment {
  readonly id: string;
  readonly periodMonth: string;
  readonly amountMinor: number;
  readonly graReceiptNumber: string;
}

interface VatReport {
  readonly invoices: { readonly invoiceId: string }[];
  readonly totals: { readonly totalMinor: number; readonly paidMinor: number };
  readonly payments: VatPayment[];
  readonly warnings: string[];
}

test.describe('P33 VAT returns', () => {
  test('an accountant reads an owner’s VAT for a month by tax point, with the unverified-rule warning, and records a VAT payment with GRA’s receipt', async ({
    page,
  }) => {
    const graNumber = `GRA-VAT-E2E-${unique()}`;
    await signIn(page, PEOPLE.accountant.email);
    await nav(page).getByRole('link', { name: 'VAT returns' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('VAT returns');

    const ownerId = await ownerIdByName(page, OWNER_B.name);
    const seeded = await apiGet<VatPayment[]>(page.request, `/vat-payments?ownerId=${ownerId}`);
    expect(seeded.length, 'a VAT payment in the seed: run pnpm db:seed').toBeGreaterThan(0);
    const month = monthOf(seeded[0]!.periodMonth);
    const report = await apiGet<VatReport>(
      page.request,
      `/vat/report?ownerId=${ownerId}&month=${month}`,
    );

    await page.goto(`/tax/vat?ownerId=${ownerId}&month=${month}`);
    const card = page.getByTestId('vat-report');
    await expect(card.getByTestId('vat-row')).toHaveCount(report.invoices.length);
    await expect(card.getByTestId('vat-total').locator('dd')).toHaveText(
      cedis(report.totals.totalMinor),
    );
    await expect(card.getByTestId('vat-paid').locator('dd')).toHaveText(
      cedis(report.totals.paidMinor),
    );
    await expect(
      card.getByTestId('vat-payment').filter({ hasText: seeded[0]!.graReceiptNumber }),
    ).toHaveCount(1);
    expect(report.warnings.length, 'the VAT rules are unverified (OQ-20)').toBeGreaterThan(0);
    await expect(card.getByTestId('rules-warning')).toBeVisible();

    // Record a VAT payment for the same month, with GRA's receipt.
    await card.getByRole('link', { name: 'Record a VAT payment' }).click();
    await ready(page, 'Record the VAT payment');
    const form = page.getByRole('form', { name: 'Record a VAT payment' });
    await expect(form.getByLabel('Owner')).toHaveValue(ownerId);
    await expect(form.getByLabel('Month of the return')).toHaveValue(month);
    await form.getByLabel('Amount paid (GH₵)').fill('12.34');
    await form.getByLabel('GRA receipt number').fill(graNumber);
    await form.getByLabel('Paid from').selectOption({ label: 'The agency’s account' });
    await form.getByLabel('GRA’s receipt').setInputFiles(fixture('title-deed.pdf'));
    await form.getByRole('button', { name: 'Record the VAT payment' }).click();
    await expect(page.getByTestId('vat-payment-recorded')).toContainText(
      `Recorded GH₵12.34 of VAT and levies paid to GRA for ${OWNER_B.option}`,
    );

    await page.getByRole('link', { name: 'Back to VAT returns' }).click();
    await expect(
      page.getByTestId('vat-report').getByTestId('vat-payment').filter({ hasText: graNumber }),
    ).toContainText('GH₵12.34');
  });
});
