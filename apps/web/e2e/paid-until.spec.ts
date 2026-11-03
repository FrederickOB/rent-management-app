import { expect, test, type Page } from '@playwright/test';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '@rent/domain/dates';
import { format, money } from '@rent/domain/money';
import { formatBusinessDate } from '../lib/business-dates';
import { leaseIdByUnit } from './billing-helpers';
import { PEOPLE, signIn } from './helpers';
import { today } from './tenancy-helpers';

/**
 * The seed's figures (plan M4a section 5), pinned rather than read back from the screen's own
 * source. Kojo Partial pays by a cheque on the seed day; Yaw Two-Year paid GH₵36,000 for a
 * 24-month lease at GH₵1,500 a month.
 */
const TWO_YEAR = 'ACC-ELG-B1-04';
const PART_PAID = 'ACC-LEG-B2-03';
const YAW_RENT_MINOR = 150_000;
const YAW_MONTHS = 24;
const KOJO_TOWARDS_MINOR = 20_000;

const cedis = (minor: number) => format(money(minor));
const dayBefore = (iso: string) => toIsoDate(addDays(parseBusinessDate(iso), -1));

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

test.describe('AR-02 the lease page shows paid-until and unearned rent', () => {
  test('for the seed’s two-year advance and a part-paid lease', async ({ page }) => {
    await signIn(page, PEOPLE.managerOne.email);

    // Kojo Partial: paid until the day before the seed day, plus GH₵200.00 towards the month
    // starting on it. The seed day is the day of his cheque.
    const partId = await leaseIdByUnit(page, PART_PAID);
    const payments = await read<{ method: string; receivedOn: string }[]>(
      page,
      `/api/v1/payments?leaseId=${partId}`,
    );
    const cheque = payments.find((p) => p.method === 'cheque');
    expect(cheque, 'the seed’s cheque from Kojo Partial').toBeTruthy();
    const seedDay = cheque!.receivedOn;
    await page.goto(`/leases/${partId}`);
    const partCard = page.getByTestId('lease-money');
    await expect(partCard.getByTestId('money-paid-until')).toContainText(
      formatBusinessDate(dayBefore(seedDay)),
    );
    await expect(partCard.getByTestId('money-partial')).toHaveText(
      `plus ${cedis(KOJO_TOWARDS_MINOR)} towards the month starting ${formatBusinessDate(seedDay)}`,
    );

    // Yaw Two-Year: the whole term is paid, so he is paid until its last day, and the rent for
    // every month not yet started is unearned: GH₵1,500 for each.
    const advanceId = await leaseIdByUnit(page, TWO_YEAR);
    const advance = await read<{ terms: { startDate: string; endDate: string } }>(
      page,
      `/api/v1/leases/${advanceId}`,
    );
    const start = parseBusinessDate(advance.terms.startDate);
    const lastDay = toIsoDate(addDays(addMonths(start, YAW_MONTHS), -1));
    expect(advance.terms.endDate, 'the seed’s 24-month term').toBe(lastDay);
    const now = today();
    let notStarted = 0;
    for (let month = 0; month < YAW_MONTHS; month += 1)
      if (toIsoDate(addMonths(start, month)) > now) notStarted += 1;
    await page.goto(`/leases/${advanceId}`);
    const card = page.getByTestId('lease-money');
    await expect(card.getByTestId('money-paid-until')).toContainText(formatBusinessDate(lastDay));
    await expect(card.getByTestId('money-partial')).toHaveCount(0);
    await expect(card.getByTestId('money-unearned-rent')).toContainText(
      cedis(YAW_RENT_MINOR * notStarted),
    );
    await expect(card.getByTestId('money-reference')).toContainText(/[0-9A-Z]{7}/);
  });
});
