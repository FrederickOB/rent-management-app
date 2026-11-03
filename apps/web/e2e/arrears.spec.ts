import { expect, test, type Page } from '@playwright/test';
import { addDays, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { formatBusinessDate } from '../lib/business-dates';
import { nav, PEOPLE, ready, signIn } from './helpers';
import { expectNoSidewaysScroll } from './register-helpers';

/**
 * The seed's tenancies in arrears (plan M4a section 5): billed from their start, partly paid,
 * then nothing. On the day the seed runs, Kofi's oldest unpaid line is 45 days past due and Esi's
 * 95 days. The seed dates everything from that day, so the spec finds it from Kofi's oldest due
 * date and checks the documented figures as of then.
 */
const FORTY_FIVE = 'Kofi Arrears-45 (demo)';
const NINETY_FIVE = 'Esi Arrears-95 (demo)';

const BUCKETS = ['0_30', '31_60', '61_90', '90_plus'] as const;
type Bucket = (typeof BUCKETS)[number];
type Buckets = Partial<Record<Bucket, number>>;

interface ArrearsRow {
  readonly label: string;
  readonly buckets: Buckets;
  readonly oldestDueDate: string;
}

const cedis = (minor: number) => format(money(minor));
const daysAfter = (iso: string, days: number) => toIsoDate(addDays(parseBusinessDate(iso), days));

async function arrearsRows(page: Page, asOf: string | null): Promise<ArrearsRow[]> {
  const response = await page.request.get(
    `/api/v1/arrears?by=tenant${asOf ? `&asOf=${asOf}` : ''}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { rows: ArrearsRow[] }).rows;
}

/** Shows the arrears as of a date, and waits for the screen to say so. */
async function asOf(page: Page, date: string) {
  await page.getByLabel('As of').fill(date);
  await expect(page.getByTestId('arrears')).toContainText(`As of ${formatBusinessDate(date)}`);
}

/** The row's amount in each bucket and its total, as the screen shows them. */
async function expectRow(page: Page, label: string, buckets: Buckets) {
  const row = page.getByTestId('arrears-row').filter({ hasText: label });
  await expect(row).toHaveCount(1);
  for (const bucket of BUCKETS) {
    const amount = buckets[bucket] ?? 0;
    await expect(row.getByTestId(`bucket-${bucket}`)).toHaveText(amount ? cedis(amount) : '—');
  }
  const total = BUCKETS.reduce((sum, b) => sum + (buckets[b] ?? 0), 0);
  await expect(row.getByTestId('arrears-total')).toHaveText(cedis(total));
}

test.describe('BC-08 arrears screen', () => {
  test('the seed’s 45- and 95-day tenants are aged into the right buckets, as of a date', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    // The seed's day: 45 days after Kofi's oldest due date, and 95 after Esi's.
    const today = await arrearsRows(page, null);
    const kofi = today.find((r) => r.label === FORTY_FIVE);
    const esi = today.find((r) => r.label === NINETY_FIVE);
    expect(kofi, `${FORTY_FIVE} is in arrears`).toBeTruthy();
    expect(esi, `${NINETY_FIVE} is in arrears`).toBeTruthy();
    const seedDay = daysAfter(kofi!.oldestDueDate, 45);
    expect(daysAfter(esi!.oldestDueDate, 95), 'both are aged from the seed day').toBe(seedDay);

    await nav(page).getByRole('link', { name: 'Arrears' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Arrears');
    await ready(page, 'By tenant');
    await expect(page.getByRole('button', { name: 'By tenant' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // As of the seed day, the figures the plan documents.
    await asOf(page, seedDay);
    await expectRow(page, FORTY_FIVE, { '0_30': 40_000, '31_60': 30_000 });
    await expectRow(page, NINETY_FIVE, {
      '0_30': 40_000,
      '31_60': 40_000,
      '61_90': 40_000,
      '90_plus': 25_000,
    });

    // The totals row adds up every row on screen, bucket by bucket.
    const all = await arrearsRows(page, seedDay);
    const totals = page.getByTestId('arrears-totals');
    for (const bucket of BUCKETS) {
      const sum = all.reduce((s, r) => s + (r.buckets[bucket] ?? 0), 0);
      await expect(totals.getByTestId(`bucket-${bucket}`)).toHaveText(cedis(sum));
    }

    // The date changes the answer. 20 days after Kofi's oldest due date, that line is young:
    // nothing of his is 31–60 days old, and his next month was not due yet.
    await asOf(page, daysAfter(kofi!.oldestDueDate, 20));
    await expectRow(page, FORTY_FIVE, { '0_30': 30_000 });
    // The day before it fell due, he owed nothing overdue: the months before were paid.
    await asOf(page, daysAfter(kofi!.oldestDueDate, -1));
    await expect(page.getByTestId('arrears-row').filter({ hasText: FORTY_FIVE })).toHaveCount(0);

    // Grouped by property and by owner, the Legon compound house and its owner appear.
    await asOf(page, seedDay);
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
