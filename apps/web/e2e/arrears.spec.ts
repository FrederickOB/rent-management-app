import { expect, test, type Page } from '@playwright/test';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { formatBusinessDate } from '../lib/business-dates';
import { nav, PEOPLE, ready, signIn } from './helpers';
import { expectNoSidewaysScroll } from './register-helpers';

/** The seed's tenancies in arrears (plan 4.21): billing started months back, then nothing paid. */
const FORTY_FIVE = 'Kofi Arrears-45 (demo)';
const NINETY_FIVE = 'Esi Arrears-95 (demo)';

const BUCKETS = ['0_30', '31_60', '61_90', '90_plus'] as const;
type Bucket = (typeof BUCKETS)[number];

interface ArrearsRow {
  readonly key: string;
  readonly label: string;
  readonly buckets: Partial<Record<Bucket, number>>;
  readonly totalMinor: number;
  readonly oldestDueDate: string;
}

const cedis = (minor: number) => format(money(minor));
const daysAfter = (iso: string, days: number) => toIsoDate(addDays(parseBusinessDate(iso), days));

async function arrears(page: Page, asOf: string | null): Promise<{ rows: ArrearsRow[] }> {
  const response = await page.request.get(
    `/api/v1/arrears?by=tenant${asOf ? `&asOf=${asOf}` : ''}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as { rows: ArrearsRow[] };
}

/** The row's amount in each bucket, as the screen shows it. */
async function expectBuckets(page: Page, label: string, row: ArrearsRow) {
  const shown = page.getByTestId('arrears-row').filter({ hasText: label });
  await expect(shown).toHaveCount(1);
  for (const bucket of BUCKETS) {
    const amount = row.buckets[bucket] ?? 0;
    await expect(shown.getByTestId(`bucket-${bucket}`)).toHaveText(amount ? cedis(amount) : '—');
  }
  await expect(shown.getByTestId('arrears-total')).toHaveText(cedis(row.totalMinor));
}

test.describe('BC-08 arrears screen', () => {
  test('the seed’s 45- and 95-day tenants are aged into the right buckets, as of a date', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    // The seed ages its tenancies from the day it was loaded; each check is pinned to the day the
    // tenant's oldest unpaid line is that many days past due, so the e2e database may be older.
    const now = await arrears(page, null);
    const kofiNow = now.rows.find((r) => r.label === FORTY_FIVE);
    const esiNow = now.rows.find((r) => r.label === NINETY_FIVE);
    expect(kofiNow, `${FORTY_FIVE} is in arrears`).toBeTruthy();
    expect(esiNow, `${NINETY_FIVE} is in arrears`).toBeTruthy();

    // 45 days after Kofi's oldest due date, that line is in 31–60 and nothing is older.
    const day45 = daysAfter(kofiNow!.oldestDueDate, 45);
    const at45 = (await arrears(page, day45)).rows.find((r) => r.label === FORTY_FIVE)!;
    expect(at45.buckets['31_60'] ?? 0).toBeGreaterThan(0);
    expect(at45.buckets['61_90'] ?? 0).toBe(0);
    expect(at45.buckets['90_plus'] ?? 0).toBe(0);

    await nav(page).getByRole('link', { name: 'Arrears' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Arrears');
    await ready(page, 'By tenant');
    await expect(page.getByRole('button', { name: 'By tenant' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByLabel('As of').fill(day45);
    await expect(page.getByTestId('arrears')).toContainText(`As of ${formatBusinessDate(day45)}`);
    await expectBuckets(page, FORTY_FIVE, at45);

    // 95 days after Esi's oldest due date, that line is over 90 days.
    const day95 = daysAfter(esiNow!.oldestDueDate, 95);
    const at95 = (await arrears(page, day95)).rows.find((r) => r.label === NINETY_FIVE)!;
    expect(at95.buckets['90_plus'] ?? 0).toBeGreaterThan(0);
    await page.getByLabel('As of').fill(day95);
    await expectBuckets(page, NINETY_FIVE, at95);

    // The totals row adds up every row on screen, bucket by bucket.
    const all = await arrears(page, day95);
    const totals = page.getByTestId('arrears-totals');
    for (const bucket of BUCKETS) {
      const sum = all.rows.reduce((s, r) => s + (r.buckets[bucket] ?? 0), 0);
      await expect(totals.getByTestId(`bucket-${bucket}`)).toHaveText(cedis(sum));
    }

    // Grouped by property and by owner, both tenants' Legon compound house and its owner appear.
    await page.getByRole('button', { name: 'By property' }).click();
    await expect(
      page.getByTestId('arrears-row').filter({ hasText: 'Legon compound house (demo)' }),
    ).toHaveCount(1);
    await page.getByRole('button', { name: 'By owner' }).click();
    await expect(
      page.getByTestId('arrears-row').filter({ hasText: 'Ama Owner-London (demo)' }),
    ).toHaveCount(1);

    // On a 5-inch phone the table scrolls inside its frame; the page does not scroll sideways.
    await page.setViewportSize({ width: 360, height: 740 });
    await expectNoSidewaysScroll(page);
  });
});
