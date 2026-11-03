import { expect, test } from '@playwright/test';
import { leaseIdByUnit } from './billing-helpers';
import { nav, PEOPLE, signIn } from './helpers';
import { apiGet } from './tax-helpers';

/**
 * AR-05's report (M5 plan 5.5 and 5.8; D6, OQ-28). The agency keeps `advance_rent_policy` off in
 * the seed: months paid ahead are recorded on every payment and nothing is flagged, so the report
 * says so. The report never calls an advance compliant, under any policy.
 */
test.describe('AR-05 the advance rent report', () => {
  test('with the check off, the report says advances are recorded and nothing is flagged, and never calls one compliant', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.agencyAdmin.email);
    const report = await apiGet<{ policy: string; rows: unknown[] }>(
      page.request,
      '/compliance/advance-rent',
    );
    expect(report.policy, 'the agency keeps the advance rent check off (OQ-28)').toBe('off');
    expect(report.rows).toEqual([]);

    await nav(page).getByRole('link', { name: 'Advance rent report' }).click();
    const card = page.getByTestId('advance-report');
    await expect(card.getByTestId('advance-policy')).toHaveText(
      'Off: advances are recorded, and nothing is flagged.',
    );
    await expect(card).toContainText('Nothing is flagged while the check is off.');
    await expect(card).toContainText('turning the check on needs no change to past records');
    await expect(card.getByTestId('advance-row')).toHaveCount(0);
    await expect(page.getByText(/compliant/i)).toHaveCount(0);

    // The two-year advance (ACC-ELG-B1-04) is over the limit for its term, and recorded: its
    // lease page says how far ahead it is paid, with no flag while the check is off (D6).
    await page.goto(`/leases/${await leaseIdByUnit(page, 'ACC-ELG-B1-04')}`);
    await expect(page.getByTestId('money-months-ahead')).toContainText(/paid \d+ months ahead/);
    await expect(page.getByTestId('advance-payment-flag')).toHaveCount(0);
    await expect(page.getByText(/compliant/i)).toHaveCount(0);
  });
});

/** The seed's landlord under `advance_rent_policy = warn` (plan 5.10): Abokobi Homes. */
const ABOKOBI = { email: 'abokobi.landlord@demo.invalid', unit: 'ACC-ABK-B1-01' };

const months = (n: number) => `${n} month${n === 1 ? '' : 's'}`;

interface ComplianceRow {
  readonly leaseId: string;
  readonly unitCode: string;
  readonly monthsAhead: number;
  readonly limitMonths: number;
  readonly rule: { readonly key: string; readonly verificationStatus: string } | null;
}

test.describe('AR-05 the advance rent report under “warn”', () => {
  test('a payment further ahead than the limit is listed with the months, the limit and the rule’s status, and flagged on its lease', async ({
    page,
  }) => {
    await signIn(page, ABOKOBI.email);
    const report = await apiGet<{ policy: string; rows: ComplianceRow[] }>(
      page.request,
      '/compliance/advance-rent',
    );
    expect(report.policy).toBe('warn');
    const flagged = report.rows.find((r) => r.unitCode === ABOKOBI.unit);
    expect(flagged, 'the year paid ahead in Abokobi Homes: run pnpm db:seed').toBeTruthy();

    await nav(page).getByRole('link', { name: 'Advance rent report' }).click();
    const card = page.getByTestId('advance-report');
    await expect(card.getByTestId('advance-policy')).toHaveText(
      'Warn: advances over the limit are flagged on the lease and listed here.',
    );
    const row = card.getByTestId('advance-row').filter({ hasText: ABOKOBI.unit });
    await expect(row.getByTestId('advance-ahead')).toHaveText(
      `${months(flagged!.monthsAhead)} paid ahead; the limit for this lease’s term is ${months(flagged!.limitMonths)}`,
    );
    await expect(row.getByTestId('advance-rule')).toContainText(flagged!.rule!.key);
    await expect(row.getByTestId('advance-rule')).toContainText('counsel');
    await expect(card.getByTestId('rules-warning')).toBeVisible();
    await expect(page.getByText(/compliant/i)).toHaveCount(0);

    // The lease page flags it too, with a link to the payment.
    await row.getByRole('link', { name: ABOKOBI.unit }).click();
    await expect(page.getByTestId('advance-payment-flag')).toContainText(
      `the limit for this lease’s term is ${months(flagged!.limitMonths)}`,
    );
    await expect(page.getByText(/compliant/i)).toHaveCount(0);
  });
});

test.describe('AR-06 the paid-until prompt', () => {
  test('leases paid until a date within the prompt window are listed with their prompt, and their lease page prompts the same', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.managerOne.email);
    const ending = await apiGet<{ leaseId: string; daysLeft: number; unitCode: string }[]>(
      page.request,
      '/leases/paid-until-ending',
    );
    await page.goto('/leases/expiring');
    const card = page.getByTestId('paid-until-ending');
    await expect(card.getByTestId('paid-until-row')).toHaveCount(ending.length);
    for (const row of ending.slice(0, 2)) {
      await expect(
        card.getByTestId('paid-until-row').filter({ hasText: row.unitCode }),
      ).toHaveCount(1);
      await page.goto(`/leases/${row.leaseId}`);
      await expect(page.getByTestId('paid-until-prompt')).toBeVisible();
      await expect(
        page.getByRole('status').filter({ hasText: 'Paid until' }).first(),
      ).toContainText(row.daysLeft === 0 ? 'Paid until today' : `${row.daysLeft} day`);
      await page.goto('/leases/expiring');
    }
  });
});
