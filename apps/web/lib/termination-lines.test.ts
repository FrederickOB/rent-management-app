import { describe, expect, it } from 'vitest';
import { terminationSteps, type TerminationFigures } from './termination';

/** A requested settlement as the API stores it, with the credit applied per line. */
const figures: TerminationFigures = {
  lastDay: '2026-11-15',
  endDate: '2027-10-31',
  breakClauseCreditsUnusedDays: false,
  creditBeforeMinor: 300_000,
  chargesMinor: 50_000,
  unusedDays: [],
  unusedDaysCreditMinor: 0,
  appliedMinor: 70_000,
  appliedLines: [
    {
      lineId: 'fee',
      invoiceNumber: 'INV-000310',
      label: 'Agreed early termination charge',
      periodStart: null,
      periodEnd: null,
      amountMinor: 50_000,
    },
    {
      lineId: 'rent',
      invoiceNumber: 'INV-000301',
      label: 'Rent',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      amountMinor: 20_000,
    },
  ],
  creditLeftMinor: 230_000,
  deductionsMinor: 0,
  refundMinor: 230_000,
  arrearsMinor: 0,
};

describe('AR-04 every step of the settlement is shown, the credit applied line by line', () => {
  it('lists what the prepayment paid on each line, oldest first, adding up to the API’s total', () => {
    const applied = terminationSteps(figures, { charges: [], deductions: [] })[2]!;
    expect(applied).toMatchObject({
      key: 'applied',
      total: 'GH₵700.00',
      lines: [
        { label: 'INV-000310 Agreed early termination charge', amount: 'GH₵500.00' },
        { label: 'INV-000301 Rent, 1 Nov 2026 to 30 Nov 2026', amount: 'GH₵200.00' },
      ],
    });
  });
});
