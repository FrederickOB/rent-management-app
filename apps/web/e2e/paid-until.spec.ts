import { expect, test, type Page } from '@playwright/test';
import { format, money } from '@rent/domain/money';
import { formatBusinessDate } from '../lib/business-dates';
import { leaseIdByUnit } from './billing-helpers';
import { PEOPLE, signIn } from './helpers';

/** The seed's two-year residential advance (plan 4.21): paid for the whole term up front. */
const TWO_YEAR = 'ACC-ELG-B1-04';
/** The seed's part-paid monthly lease. */
const PART_PAID = 'ACC-LEG-B2-03';

const cedis = (minor: number) => format(money(minor));

interface LeaseTerms {
  readonly terms: { readonly endDate: string; readonly monthlyRentMinor: number };
}

interface Billing {
  readonly paidUntil: string | null;
  readonly partial: { readonly monthStart: string; readonly amountMinor: number } | null;
  readonly unearnedRentMinor: number;
  readonly notBilledReason: string | null;
}

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

test.describe('AR-02 the lease page shows paid-until and unearned rent', () => {
  test('for the seed’s two-year advance and a part-paid lease', async ({ page }) => {
    await signIn(page, PEOPLE.managerOne.email);

    // The two-year advance: every month of the term is paid, so it is paid until the lease's last
    // day, and the rent for the months not started yet is unearned, shown in cedis.
    const advanceId = await leaseIdByUnit(page, TWO_YEAR);
    const advance = await read<LeaseTerms>(page, `/api/v1/leases/${advanceId}`);
    const advanceMoney = await read<Billing>(page, `/api/v1/leases/${advanceId}/billing`);
    expect(advanceMoney.notBilledReason).toBeNull();
    expect(advanceMoney.paidUntil).toBe(advance.terms.endDate);
    expect(advanceMoney.partial).toBeNull();
    // Whole months of rent are unearned: some are, and never more than the term.
    const rent = advance.terms.monthlyRentMinor;
    expect(advanceMoney.unearnedRentMinor % rent).toBe(0);
    expect(advanceMoney.unearnedRentMinor).toBeGreaterThan(0);
    expect(advanceMoney.unearnedRentMinor).toBeLessThanOrEqual(24 * rent);

    await page.goto(`/leases/${advanceId}`);
    const card = page.getByTestId('lease-money');
    await expect(card.getByTestId('money-paid-until')).toContainText(
      formatBusinessDate(advance.terms.endDate),
    );
    await expect(card.getByTestId('money-partial')).toHaveCount(0);
    await expect(card.getByTestId('money-unearned-rent')).toContainText(
      cedis(advanceMoney.unearnedRentMinor),
    );
    await expect(card.getByTestId('money-reference')).toContainText(/[0-9A-Z]{7}/);

    // The part-paid lease: what is paid towards the next month shows as partial cover, in the
    // words of prd-issues 17.
    const partId = await leaseIdByUnit(page, PART_PAID);
    const part = await read<Billing>(page, `/api/v1/leases/${partId}/billing`);
    expect(part.partial, 'the part-paid lease has partial cover').not.toBeNull();
    const partial = part.partial!;
    await page.goto(`/leases/${partId}`);
    const partCard = page.getByTestId('lease-money');
    const towards = `${cedis(partial.amountMinor)} towards the month starting ${formatBusinessDate(partial.monthStart)}`;
    await expect(partCard.getByTestId('money-partial')).toHaveText(
      part.paidUntil ? `plus ${towards}` : towards,
    );
    await expect(partCard.getByTestId('money-paid-until')).toContainText(
      part.paidUntil ? formatBusinessDate(part.paidUntil) : 'Not a whole month yet',
    );
    await expect(partCard.getByTestId('money-unearned-rent')).toContainText(
      cedis(part.unearnedRentMinor),
    );
  });
});
