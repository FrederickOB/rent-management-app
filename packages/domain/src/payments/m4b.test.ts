import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkLeaseTerms } from '../tenancy/lease-terms';
import { rentSchedule } from '../tenancy/schedule';
import {
  cyclesToIssue,
  invoiceCycles,
  invoiceLinesFor,
  type ScheduleRow,
} from '../billing/invoicing';
import { LeaseLedgerModel } from '../billing/testing/lease-ledger';
import { balanceOf, checkEntry } from '../ledger/journal';
import { unmatchedMatchLines } from '../ledger/posting';
import { settlementEntryLines, shareSettlementFees } from '../ledger/settlement-posting';
import {
  chargeReference,
  invoiceRemainingMinor,
  payPageDueMinor,
  remainingTermMinor,
} from './pay-links';

const lease = { propertyId: 'p', unitId: 'u', leaseId: 'l', tenantId: 't' };

/** A monthly lease from 2026-11-01 with service charge, its first invoices issued. */
function monthlyLease(today: string) {
  const terms = checkLeaseTerms({
    startDate: '2026-11-01',
    endDate: '2027-10-31',
    monthlyRentMinor: 150_000,
    serviceChargeMonthlyMinor: 20_000,
    cycle: 'monthly',
    noticeDays: 30,
    use: 'residential',
  });
  const schedule: ScheduleRow[] = rentSchedule(terms).map((p) => ({
    id: `cp-${p.chargeType}-${p.sequence}`,
    sequence: p.sequence,
    chargeType: p.chargeType,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    amountMinor: p.amountMinor,
    source: 'schedule' as const,
  }));
  const model = new LeaseLedgerModel(today);
  model.scheduled = schedule.map((s) => ({ ...s }));
  const cycles = invoiceCycles({
    cycle: 'monthly',
    initialAdvanceMonths: null,
    schedule,
    billingStartDate: terms.startDate,
    lastBillableDay: terms.endDate,
    leadDays: 14,
  });
  for (const c of cyclesToIssue(cycles, model.today, new Set()))
    model.issue(invoiceLinesFor(c, null), c.dueDate, c.cycleStart);
  model.accrueTo(model.today);
  return model;
}

describe('BC-04 what the pay page asks for', () => {
  it('is this invoice and anything older, after the lease’s credit, even before it is due', () => {
    const model = monthlyLease('2026-10-20');
    const walk = model.walk();
    expect(
      payPageDueMinor({
        lines: model.lines,
        allocations: model.allocations,
        walk,
        today: model.today,
        invoiceDueDate: '2026-11-01',
      }),
    ).toBe(170_000);
    // Twelve months of rent and service charge left in the term.
    expect(remainingTermMinor({ lines: model.lines, allocations: model.allocations, walk })).toBe(
      170_000 * 12,
    );
    model.pay(200_000);
    const after = model.walk();
    expect(
      payPageDueMinor({
        lines: model.lines,
        allocations: model.allocations,
        walk: after,
        today: model.today,
        invoiceDueDate: '2026-11-01',
      }),
    ).toBe(0);
    expect(
      remainingTermMinor({ lines: model.lines, allocations: model.allocations, walk: after }),
    ).toBe(170_000 * 12 - 200_000);
    expect(
      invoiceRemainingMinor({
        invoiceLines: model.lines,
        allocations: model.allocations,
        walk: after,
      }),
    ).toBe(0);
  });

  it('names each charge with a reference Paystack accepts, from the intent id', () => {
    expect(chargeReference('0192f5a8-1111-7222-8333-444455556666')).toBe(
      'pi-0192f5a8111172228333444455556666',
    );
    expect(() => chargeReference('not-a-uuid')).toThrow();
  });
});

describe('P22 settlement payment by payment', () => {
  it('shares the fees by gross, exactly, and each book’s entry balances', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 100, max: 5_000_000 }), { minLength: 1, maxLength: 15 }),
        fc.integer({ min: 0, max: 300 }),
        fc.array(fc.integer({ min: 1, max: 50_000 }), { maxLength: 3 }),
        (amounts, feeBps, deductions) => {
          const payments = amounts.map((amountMinor, i) => ({ paymentId: `p-${i}`, amountMinor }));
          const gross = amounts.reduce((s, a) => s + a, 0);
          const fees = Math.floor((gross * feeBps) / 10_000);
          const shares = shareSettlementFees(payments, fees);
          expect(shares.reduce((s, x) => s + x.feesMinor, 0)).toBe(fees);
          const lines = settlementEntryLines({
            bookId: 'b',
            to: '1070',
            provider: 'paystack',
            settlementId: 's-1',
            settlementAccountId: 'sa',
            shares,
            deductions: deductions.map((amountMinor, i) => ({ paymentId: `r-${i}`, amountMinor })),
          });
          checkEntry(lines, () => 'owner');
          const deducted = deductions.reduce((s, d) => s + d, 0);
          expect(balanceOf(lines, { accountCode: '1070' })).toBe(gross - fees - deducted);
          expect(balanceOf(lines, { accountCode: '5200' })).toBe(fees);
          expect(balanceOf(lines, { accountCode: '1050' })).toBe(deducted - gross);
        },
      ),
    );
  });
});

describe('BC-12 matching money already settled into the agency’s account', () => {
  it('moves its net and its fee from the company book to the owner’s, each book balanced', () => {
    const lines = unmatchedMatchLines({
      suspenseBookId: 'company',
      bookId: 'owner',
      holding: { bookId: 'company', account: '1050', provider: 'paystack' },
      holdings: [
        { side: { bookId: 'company', account: '1070' }, amountMinor: 97_075 },
        { side: { bookId: 'company', account: '5200' }, amountMinor: 2_925 },
      ],
      paymentId: 'pay-1',
      lease,
      allocations: [],
      surplusMinor: 100_000,
    });
    checkEntry(lines, (b) => (b === 'company' ? 'company' : 'owner'));
    expect(balanceOf(lines, { bookId: 'company', accountCode: '1070' })).toBe(-97_075);
    expect(balanceOf(lines, { bookId: 'owner', accountCode: '5200' })).toBe(2_925);
    expect(() =>
      unmatchedMatchLines({
        suspenseBookId: 'company',
        bookId: 'owner',
        holding: { bookId: 'company', account: '1050' },
        holdings: [{ side: { bookId: 'company', account: '1070' }, amountMinor: 1 }],
        paymentId: 'pay-1',
        lease,
        allocations: [],
        surplusMinor: 100_000,
      }),
    ).toThrow(/add up/);
  });
});
