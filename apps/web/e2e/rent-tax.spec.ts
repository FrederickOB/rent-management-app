import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { nav, PEOPLE, ready, signIn, unique } from './helpers';
import { fixture, OWNER_A } from './register-helpers';
import { apiGet, cedis, ownerIdByName, pesewasOf } from './tax-helpers';

/**
 * TX-01 to TX-03 on the rent tax screens (M5 plan 5.8). Ama Owner-London (OWN-01) is outside the
 * letting business in the seed, so every receipt of her rent carries rent tax at the residential
 * rate. The figures are read from the API and checked against the screen, never assumed.
 */
interface Item {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly accountingDate: string;
  readonly dueDate: string | null;
  readonly taxMinor: number;
  readonly outstandingMinor: number;
  readonly paymentId: string | null;
  readonly alertsReached?: number[];
}

test.describe('TX-01 and TX-03 the rent tax report', () => {
  test('an accountant reads an owner’s rent tax for a period: each receipt’s tax adds up to the report’s, with the unverified-rule warning, and the CSV and PDF download', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.accountant.email);
    await nav(page).getByRole('link', { name: 'Rent tax' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rent tax');

    const ownerId = await ownerIdByName(page, OWNER_A.name);
    const items = await apiGet<Item[]>(page.request, `/rent-tax/items?ownerId=${ownerId}`);
    expect(items.length, 'rent tax on the seeded receipts: run pnpm db:seed').toBeGreaterThan(0);
    const dates = items.map((i) => i.accountingDate).sort();
    const from = dates[0]!;
    const to = dates.at(-1)!;
    const report = await apiGet<{
      items: Item[];
      totals: { taxMinor: number };
      warnings: string[];
    }>(page.request, `/rent-tax/report?ownerId=${ownerId}&from=${from}&to=${to}`);

    await page.goto(`/tax/rent?ownerId=${ownerId}&from=${from}&to=${to}`);
    const card = page.getByTestId('rent-tax-report');
    const rows = card.getByTestId('rent-tax-item');
    await expect(rows).toHaveCount(report.items.length);
    // The acceptance criterion (TX-01): the report's rent tax is the tax on each receipt in it.
    const shown = await card.getByTestId('rent-tax-amount').allTextContents();
    const total = card.getByTestId('rent-tax-total-tax').locator('dd');
    await expect(total).toHaveText(cedis(report.totals.taxMinor));
    expect(shown.reduce((sum, text) => sum + pesewasOf(text), 0)).toBe(report.totals.taxMinor);
    // The base and rounding rules are unverified (OQ-17, OQ-19): staff are told on the report.
    expect(report.warnings.length, 'the seeded rent tax rules are unverified').toBeGreaterThan(0);
    await expect(card.getByTestId('rules-warning')).toBeVisible();
    await expect(page.getByText(/compliant/i)).toHaveCount(0);

    // The CSV is the API's, byte for byte, saved under its own name.
    const downloading = page.waitForEvent('download');
    await card.getByRole('button', { name: 'Download the CSV' }).click();
    const csv = await downloading;
    expect(csv.suggestedFilename()).toBe(`rent-tax-${from}-to-${to}.csv`);
    const text = await readFile(await csv.path(), 'utf8');
    expect(text.startsWith('"')).toBe(true);
    expect(text).toContain('\r\n');
    const api = await apiGet<{ content: string }>(
      page.request,
      `/rent-tax/report/csv?ownerId=${ownerId}&from=${from}&to=${to}`,
    );
    expect(text).toBe(api.content);

    // The PDF is rendered by the worker and opens once it is ready.
    const rendered = page.waitForResponse(
      async (r) =>
        /\/api\/v1\/rent-tax\/report\/pdf\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname) &&
        r.status() === 200 &&
        ((await r.json()) as { status: string }).status === 'ready',
      { timeout: 60_000 },
    );
    const tab = page.waitForEvent('popup');
    await card.getByRole('button', { name: 'Download the PDF' }).click();
    const { url } = (await (await rendered).json()) as { url: string };
    (await tab).close().catch(() => undefined);
    const pdf = await page.request.get(url);
    expect(pdf.status()).toBe(200);
    expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await expect(card.getByRole('alert')).toHaveCount(0);

    // Each receipt's tax is on its payment too, with the rule warning.
    const receipt = report.items.find((i) => i.kind === 'receipt' && i.paymentId);
    expect(receipt, 'a receipt in the period').toBeTruthy();
    await page.goto(`/payments/${receipt!.paymentId}`);
    const tax = page.getByTestId('payment-tax');
    await expect(tax.getByTestId('payment-tax-item').first()).toBeVisible();
    await expect(tax.getByTestId('payment-tax-amount').first()).toHaveText(
      cedis(receipt!.taxMinor),
    );
    await expect(tax.getByTestId('rules-warning')).toBeVisible();
  });
});

test.describe('TX-02 the rent tax due list', () => {
  test('lists what is owed to GRA, oldest due first, with the 21- and 28-day alerts; tax the tenant withheld is never on it', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.accountant.email);
    const due = await apiGet<Item[]>(page.request, '/rent-tax/due');
    expect(due.length, 'open rent tax in the seed: run pnpm db:seed').toBeGreaterThan(0);
    expect(due.every((i) => i.status === 'open' || i.status === 'part_paid')).toBe(true);
    await page.goto('/tax/rent');
    const list = page.getByTestId('rent-tax-due');
    const rows = list.getByTestId('rent-tax-item');
    await expect(rows).toHaveCount(due.filter((i) => i.outstandingMinor > 0).length);
    // Oldest due first.
    const first = [...due].sort(
      (a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.id.localeCompare(b.id),
    )[0]!;
    await expect(rows.first()).toHaveAttribute('data-item-id', first.id);
    // Each row says where it stands; an item that reached an alert day says which.
    for (const item of due.filter((i) => (i.alertsReached ?? []).length > 0).slice(0, 3)) {
      const badge = list.locator(`[data-item-id="${item.id}"]`).getByTestId('rent-tax-due-state');
      await expect(badge).toHaveText(
        new RegExp(`${Math.max(...item.alertsReached!)}-day alert|Overdue by`),
      );
    }
    await expect(list.getByText('Withheld by the tenant')).toHaveCount(0);
  });
});

test.describe('TX-03 a GRA payment', () => {
  test('an accountant records rent tax paid to GRA with its receipt; it settles the oldest item first, which then shows as paid', async ({
    page,
  }) => {
    const graNumber = `GRA-E2E-${unique()}`;
    await signIn(page, PEOPLE.accountant.email);
    const ownerId = await ownerIdByName(page, OWNER_A.name);
    const due = await apiGet<Item[]>(page.request, `/rent-tax/due?ownerId=${ownerId}`);
    const oldest = [...due].sort(
      (a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.id.localeCompare(b.id),
    )[0];
    expect(oldest, 'rent tax owed for Owner A: run pnpm db:seed').toBeTruthy();

    await page.goto(`/tax/rent/payments/new?ownerId=${ownerId}`);
    const form = page.getByRole('form', { name: 'Record a GRA payment' });
    await ready(page, 'Record the GRA payment');
    await expect(form.getByTestId('gra-item').first()).toBeVisible();
    await form
      .getByLabel('Amount paid (GH₵)')
      .fill(cedis(oldest!.outstandingMinor).replace('GH₵', ''));
    // Oldest first by default: the oldest item is ticked, and the payment settles all it owes.
    const item = form.getByTestId('gra-item').first();
    await expect(item.getByRole('checkbox')).toBeChecked();
    await expect(item).toContainText(
      `This payment settles ${cedis(oldest!.outstandingMinor)} of it.`,
    );
    await form.getByLabel('GRA receipt number').fill(graNumber);
    await form.getByLabel('Paid from').selectOption({ label: 'The agency’s account' });
    await form.getByLabel('GRA’s receipt').setInputFiles(fixture('title-deed.pdf'));
    await form.getByRole('button', { name: 'Record the GRA payment' }).click();
    await expect(page.getByTestId('gra-payment-recorded')).toContainText(
      `Recorded ${cedis(oldest!.outstandingMinor)} paid to GRA for ${OWNER_A.option}, settling 1 tax item.`,
    );

    const after = await apiGet<Item[]>(page.request, `/rent-tax/items?ownerId=${ownerId}`);
    expect(after.find((i) => i.id === oldest!.id)?.status).toBe('paid');
    const payments = await apiGet<{ graReceiptNumber: string; items: { itemId: string }[] }[]>(
      page.request,
      `/gra-payments?ownerId=${ownerId}`,
    );
    expect(payments.find((p) => p.graReceiptNumber === graNumber)?.items).toEqual([
      expect.objectContaining({ itemId: oldest!.id }),
    ]);
  });

  test('a property manager reads rent tax but is not offered to pay GRA', async ({ page }) => {
    await signIn(page, PEOPLE.managerOne.email);
    await nav(page).getByRole('link', { name: 'Rent tax' }).click();
    await expect(page.getByTestId('rent-tax-due')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Record a GRA payment' })).toHaveCount(0);
    await page.goto('/tax/rent/payments/new');
    await expect(page.getByTestId('no-access')).toBeVisible();
  });
});
