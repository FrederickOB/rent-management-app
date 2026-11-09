import { expect, test } from '@playwright/test';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { money, toDecimal } from '@rent/domain/money';
import { cancelEffectiveOn } from '@rent/domain/subscription';
import { formatBusinessDate } from '../lib/business-dates';
import { unique } from './helpers';
import {
  firstAdmin,
  forceInvoice,
  ok,
  onboard,
  payByCard,
  payByMomo,
  platformAdmin,
} from './subscription-support';
import { cedis } from './tax-helpers';
import { today } from './tenancy-helpers';

/**
 * More of M10 plan section 6, end to end (web; review WEB-12): an invoice with its lines,
 * snapshot and PDF (PB-02); cancelling, withdrawing and the export (PB-10); a discount code made
 * in the console and applied by the subscriber, and a trial extended (PB-05, PB-08, AD-10); paying
 * by MoMo (AD-08); a credit note from the console, seen by the subscriber (founder answer Q2;
 * review WEB-17); a year paid ahead, and cancelling within it (PB-05, PB-10, founder answer Q3).
 * Each test onboards its own company. What they rely on is listed at the top of
 * `subscription-support.ts` (A1 to A7), plus, here: A8, a code counts as used when it is applied,
 * with all its months left until the first invoice it covers.
 *
 * Not end to end: turning billing on (global, and the seed turns it on) and starting a new
 * subscription for a cancelled company (no test control reaches "cancelled"); their wording is
 * unit-tested.
 *
 * New subscription terms are not added end to end: they are global and would change every other
 * company's trial and grace. Their wording is unit-tested (`termsRows`).
 */

test.describe.configure({ timeout: 300_000 });

interface SubscriptionRead {
  readonly status: string;
  readonly trialEndsOn: string | null;
}

test.describe('PB-02 an invoice shows its lines, its snapshot and its PDF', () => {
  test('the invoice page lists lines that add up to its total, the units billed, and downloads the PDF', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'agency', tier: 'growth', trialDays: 0 });
    const admin = await firstAdmin(browser, baseURL, company);
    try {
      const invoice = await forceInvoice(platform.page, company.companyId, 0);
      const page = admin.page;
      const detail = await ok<{ lines: { amountMinor: number }[]; totalMinor: number }>(
        await page.request.get(`/api/v1/subscription/invoices/${invoice.id}`),
        'read the invoice',
      );
      expect(detail.lines.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(detail.totalMinor);

      await page.goto('/settings/subscription');
      await page.getByRole('link', { name: invoice.number }).click();
      await expect(page.getByRole('heading', { name: `Invoice ${invoice.number}` })).toBeVisible();
      await expect(page.getByTestId('subscription-invoice-line')).toHaveCount(detail.lines.length);
      const total = page.getByTestId('subscription-invoice').getByRole('row', { name: /^Total/ });
      await expect(total).toContainText(cedis(invoice.totalMinor));
      const snapshot = page.getByTestId('subscription-snapshot');
      await expect(snapshot).toContainText('Every band:');
      await expect(snapshot).toContainText('Vacant units are not billed.');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.getByRole('button', { name: 'Download the PDF' }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
    } finally {
      await admin.context.close();
      await platform.context.close();
    }
  });
});

test.describe('PB-10 cancelling, withdrawing it, and the export', () => {
  test('the export downloads; a cancellation in the trial ends by its last day with nothing billed, and is withdrawn', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'landlord', tier: 'starter' });
    await platform.context.close();
    const admin = await firstAdmin(browser, baseURL, company);
    try {
      const page = admin.page;
      await page.goto('/settings/subscription');
      const end = page.getByTestId('subscription-end');

      const [workbook] = await Promise.all([
        page.waitForEvent('download', { timeout: 150_000 }),
        end.getByRole('button', { name: 'Export your data' }).click(),
      ]);
      expect(workbook.suggestedFilename()).toMatch(/\.xlsx$/i);

      // When it ends: the domain's rule, from the trial the API reports.
      const before = await ok<SubscriptionRead>(
        await page.request.get('/api/v1/subscription'),
        'read the subscription',
      );
      expect(before.status).toBe('trialing');
      const endsOn = cancelEffectiveOn({
        today: today(),
        status: 'trialing',
        trialEndsOn: before.trialEndsOn,
      });
      await end.getByRole('button', { name: 'Cancel the subscription' }).click();
      const confirm = page.getByRole('group', { name: 'Confirm cancelling the subscription' });
      await expect(confirm).toContainText(
        `The subscription ends on ${formatBusinessDate(endsOn)}, within the free trial, so nothing is billed.`,
      );
      await confirm
        .getByRole('button', { name: `Yes, end it on ${formatBusinessDate(endsOn)}` })
        .click();
      await expect(
        page.getByText(
          `The subscription will end on ${formatBusinessDate(endsOn)}. Nothing is billed.`,
        ),
      ).toBeVisible();
      await expect(page.getByTestId('subscription-status')).toHaveText('Ending this month');
      await expect(page.getByTestId('subscription-cancels')).toContainText('nothing is billed');

      await end.getByRole('button', { name: 'Keep the subscription' }).click();
      await expect(
        page.getByText('The cancellation is withdrawn: the subscription carries on.'),
      ).toBeVisible();
      await expect(page.getByTestId('subscription-status')).toHaveText('Free trial');
      await expect(page.getByTestId('subscription-cancels')).toHaveCount(0);
    } finally {
      await admin.context.close();
    }
  });
});

test.describe('PB-05, PB-08 and AD-10 a discount code from the console, and a longer trial', () => {
  test('the platform admin adds a code and extends a trial; the subscriber applies the code once', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'agency', tier: 'growth' });
    const admin = await firstAdmin(browser, baseURL, company);
    try {
      const consolePage = platform.page;
      const code = `E2E-${unique()}`;

      // A code in Plans and billing: 10% off for 3 months, at most 5 uses.
      await consolePage.goto('/platform/billing?tab=codes');
      await consolePage.getByRole('button', { name: 'Add a discount code' }).click();
      const form = consolePage.getByRole('form', { name: 'New discount code' });
      await form.getByLabel('Code').fill(code);
      await form.getByLabel('Kind').selectOption('percentage');
      await form.getByLabel('Percentage off').fill('10');
      await form.getByLabel('For how many months').fill('3');
      await form.getByLabel('Most uses (optional)').fill('5');
      await form.getByRole('button', { name: 'Add the code' }).click();
      await expect(consolePage.getByText(`Added ${code}.`)).toBeVisible();
      const row = consolePage.getByTestId('discount-code-row').filter({ hasText: code });
      await expect(row).toContainText('10% off for 3 months');
      await expect(row).toContainText('used 0 of 5 times');

      // The subscriber applies it, and it shows on the plan with its months left.
      const page = admin.page;
      await page.goto('/settings/subscription');
      const apply = page.getByRole('form', { name: 'Apply a discount code' });
      await apply.getByLabel('Discount code').fill(code);
      await apply.getByRole('button', { name: 'Apply the code' }).click();
      await expect(page.getByText(new RegExp(`^Applied ${code}`))).toBeVisible();
      await expect(page.getByTestId('subscription-discount')).toContainText(code);
      await expect(page.getByTestId('subscription-discount')).toContainText('3 months left');
      await consolePage.reload();
      await expect(
        consolePage.getByTestId('discount-code-row').filter({ hasText: code }),
      ).toContainText('used 1 of 5 times');

      // The trial, a week longer, with a reason kept in the audit log.
      const before = await ok<{ trialEndsOn: string | null }>(
        await consolePage.request.get(`/api/v1/platform/companies/${company.companyId}`),
        'read the company',
      );
      expect(before.trialEndsOn).not.toBeNull();
      const longer = toIsoDate(addDays(parseBusinessDate(before.trialEndsOn!), 7));
      await consolePage.goto(`/platform/companies/${company.companyId}`);
      await consolePage.getByRole('button', { name: 'Extend the trial' }).click();
      await consolePage.getByLabel('Days to add').fill('7');
      const extend = consolePage.getByRole('form', { name: 'Extend the free trial' });
      await extend.getByLabel('Reason').fill(`Pilot onboarding took longer ${unique()}`);
      await extend.getByRole('button', { name: 'Extend the trial' }).click();
      await expect(
        consolePage.getByText(`The free trial now ends on ${formatBusinessDate(longer)}.`),
      ).toBeVisible();
    } finally {
      await admin.context.close();
      await platform.context.close();
    }
  });
});

test.describe('AD-08 paying by MoMo', () => {
  test('an open invoice is paid by a MoMo prompt approved on the phone, and the receipt says mobile money', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'agency', tier: 'growth', trialDays: 0 });
    const admin = await firstAdmin(browser, baseURL, company);
    try {
      const invoice = await forceInvoice(platform.page, company.companyId, 0);
      const page = admin.page;
      await payByMomo(page);
      const row = page.getByTestId('subscription-invoice-row').filter({ hasText: invoice.number });
      await expect(row.getByTestId('subscription-invoice-state')).toHaveText('Paid');
      const receipt = page
        .getByTestId('subscription-receipt-row')
        .filter({ hasText: invoice.number });
      await expect(receipt).toContainText('Mobile money');
      await expect(receipt).toContainText(cedis(invoice.totalMinor));
    } finally {
      await admin.context.close();
      await platform.context.close();
    }
  });
});

test.describe('AD-10 and PB-07 a credit note from the console, seen by the subscriber', () => {
  test('the platform admin credits part of an invoice with a reason; the subscriber sees the credit note and less to pay', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'agency', tier: 'growth', trialDays: 0 });
    const admin = await firstAdmin(browser, baseURL, company);
    try {
      const invoice = await forceInvoice(platform.page, company.companyId, 0);
      // Half the invoice, to the pesewa, so something is still left to pay.
      const creditMinor = (invoice.totalMinor - (invoice.totalMinor % 2)) / 2;
      const typed = toDecimal(money(creditMinor));
      const reason = `Goodwill for a slow first week ${unique()}`;

      const consolePage = platform.page;
      await consolePage.goto(`/platform/companies/${company.companyId}?tab=invoices`);
      await consolePage.getByRole('link', { name: invoice.number }).click();
      const form = consolePage.getByRole('form', { name: 'Credit this invoice' });
      await form.getByLabel('Amount to credit (GH₵)').fill(typed);
      await form.getByLabel('Reason').fill(reason);
      await form.getByRole('button', { name: 'Credit the invoice' }).click();
      await form
        .getByRole('group', { name: `Confirm the credit on invoice ${invoice.number}` })
        .getByRole('button', { name: `Yes, credit ${cedis(creditMinor)}` })
        .click();
      const done = consolePage.getByText(
        `takes ${cedis(creditMinor)} off invoice ${invoice.number}.`,
      );
      await expect(done).toBeVisible();
      await expect(done).toContainText(/^Credit note SUBC-\d{4}-\d{6} /);
      await expect(
        consolePage.getByTestId('credit-note-row').filter({ hasText: reason }),
      ).toContainText(cedis(creditMinor));

      // The subscriber sees the credit note on the invoice, and what is left to pay.
      const page = admin.page;
      await page.goto(`/settings/subscription/invoices/${invoice.id}`);
      const note = page.getByTestId('credit-note-row').filter({ hasText: reason });
      await expect(note).toContainText(/SUBC-\d{4}-\d{6}/);
      await expect(note).toContainText(cedis(creditMinor));
      await expect(page.getByTestId('invoice-credited')).toHaveText(cedis(creditMinor));
      await expect(page.getByTestId('invoice-outstanding')).toHaveText(
        cedis(invoice.totalMinor - creditMinor),
      );
    } finally {
      await admin.context.close();
      await platform.context.close();
    }
  });
});

test.describe('PB-05 and PB-10 a year paid ahead', () => {
  test('a year ahead is paid by card at the quoted price, shows as the annual term, and a cancellation ends with that year', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'agency', tier: 'growth', trialDays: 0 });
    await platform.context.close();
    const admin = await firstAdmin(browser, baseURL, company);
    try {
      const page = admin.page;
      // Nothing is open, so a year ahead is offered at the API's quote (BE-23).
      const before = await ok<{
        openMinor: number;
        annualPrice: { totalMinor: number } | null;
        actions: { payAnnual: boolean };
      }>(await page.request.get('/api/v1/subscription'), 'read the subscription');
      expect(before.openMinor).toBe(0);
      expect(before.actions.payAnnual).toBe(true);
      const price = before.annualPrice!.totalMinor;
      await page.goto('/settings/subscription');
      await expect(
        page
          .getByRole('form', { name: 'Pay the subscription' })
          .getByLabel(/^Twelve months up front/),
      ).toHaveAccessibleName(
        new RegExp(`^Twelve months up front: ${cedis(price).replace(/[.]/g, '\\.')} for `),
      );

      await payByCard(page, 'annual');
      const term = page.getByTestId('subscription-annual');
      await expect(term).toContainText('Paid a year ahead');
      const receipt = page
        .getByTestId('subscription-receipt-row')
        .filter({ hasText: 'Twelve months up front' });
      await expect(receipt).toContainText(cedis(price));

      // Cancelling during the paid year ends the service when that year ends (founder, Q3).
      const after = await ok<{ annual: { endsOn: string } | null }>(
        await page.request.get('/api/v1/subscription'),
        'read the subscription',
      );
      const endsOn = after.annual!.endsOn;
      const end = page.getByTestId('subscription-end');
      await end.getByRole('button', { name: 'Cancel the subscription' }).click();
      const confirm = page.getByRole('group', { name: 'Confirm cancelling the subscription' });
      await expect(confirm).toContainText(
        `Your service ends on ${formatBusinessDate(endsOn)}, when the year you paid for ends.`,
      );
      await confirm
        .getByRole('button', { name: `Yes, end it on ${formatBusinessDate(endsOn)}` })
        .click();
      await expect(page.getByTestId('subscription-cancels')).toContainText(
        `Your service ends on ${formatBusinessDate(endsOn)}, when the year you paid for ends.`,
      );
    } finally {
      await admin.context.close();
    }
  });
});
