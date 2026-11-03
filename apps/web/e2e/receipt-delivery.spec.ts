import { expect, test } from '@playwright/test';
import { leaseIdByUnit } from './billing-helpers';
import { nav, PEOPLE, signIn } from './helpers';

/**
 * BC-06 and BC-09 on staff screens (M4b plan 4.6 and 4.7). The seed's two-yearly lease
 * (ACC-ELG-B1-06) was paid by card through the pay page by Ama Tenant, who agreed to SMS: its
 * receipt goes to her by SMS once the worker has sent it, with the time from the payment's
 * confirmation to the send. Kofi Arrears-45's overdue invoice shows the company's reminder
 * ladder step by step.
 */
const PAID_BY_CARD = 'ACC-ELG-B1-06';
const OVERDUE = 'ACC-LEG-B2-01';
const DELIVERY_LABELS =
  /^(Sent by SMS|Sent by email|On its way to the tenant|Not sent: no channel we may use|Could not be sent|Not sent to the tenant)$/;

test.describe('BC-06 a receipt’s delivery to the tenant', () => {
  test('the payment page shows the receipt sent by SMS, and how long after confirmation', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const leaseId = await leaseIdByUnit(page, PAID_BY_CARD);
    const payments = (await (
      await page.request.get(`/api/v1/payments?leaseId=${leaseId}`)
    ).json()) as { id: string; method: string }[];
    const card = payments.find((p) => p.method === 'card');
    expect(card, 'the seed’s card payment through the pay page: run pnpm db:seed').toBeTruthy();

    // The worker sends it within a minute of the payment's confirmation; a fresh seed may still
    // have it on its way when the spec starts.
    await expect(async () => {
      await page.goto(`/payments/${card!.id}`);
      await expect(page.getByTestId('receipt-delivery-label').first()).toHaveText('Sent by SMS', {
        timeout: 1_000,
      });
    }).toPass({ timeout: 90_000 });
    await expect(page.getByTestId('receipt-delivery-detail').first()).toContainText(
      'after the payment was confirmed',
    );

    // The receipts list shows it too, in a word and a time.
    await nav(page).getByRole('link', { name: 'Receipts' }).click();
    const labels = page.getByTestId('receipt-delivery-label');
    await expect(labels.first()).toBeVisible();
    for (const label of await labels.allTextContents()) expect(label).toMatch(DELIVERY_LABELS);
  });
});

test.describe('BC-09 an invoice’s reminders', () => {
  test('an overdue invoice shows each step of the company’s ladder: sent, skipped or still to go', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const leaseId = await leaseIdByUnit(page, OVERDUE);
    const open = (await (
      await page.request.get(`/api/v1/invoices?leaseId=${leaseId}&overdue=true`)
    ).json()) as { id: string }[];
    expect(open.length, 'an overdue invoice on ACC-LEG-B2-01: run pnpm db:seed').toBeGreaterThan(0);
    await page.goto(`/invoices/${open[0]!.id}`);
    const steps = page.getByTestId('invoice-reminder');
    // The seed keeps the PRD's ladder: 7 days before, on the day, and 3, 7 and 14 days after.
    await expect(steps).toHaveCount(5);
    await expect(steps.first()).toContainText('7 days before');
    await expect(steps.nth(1)).toContainText('On the due date');
    for (const text of await steps.allTextContents())
      expect(text).toMatch(/Sent|Skipped|Due to go/);
  });
});
