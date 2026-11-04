import { describe, expect, it } from 'vitest';
import { balanceOf, checkEntry } from '../ledger/journal';
import {
  certificateLines,
  creditApplicationLines,
  graPaymentLines,
  refundApprovedLines,
  refundPaidLines,
  rentTaxLines,
  vatPaymentLines,
  withholdingLines,
  withholdingWriteOffLines,
} from '../ledger/tax-posting';
import { checkLeaseTerms } from '../tenancy/lease-terms';
import { rentSchedule } from '../tenancy/schedule';
import { maxPaymentWithinCap, monthsPaidAhead } from './advance-cap';
import { cyclesToIssue, invoiceCycles, invoiceLinesFor, type ScheduleRow } from './invoicing';
import { creditPools } from './lines';
import { applyCreditToOpenLines, refundDue, unusedDaysCredits } from './termination';
import { LeaseLedgerModel } from './testing/lease-ledger';

const lease = { propertyId: 'p', unitId: 'u', leaseId: 'l', tenantId: 't' };
const owner = () => 'owner' as const;

function monthlyLease(today: string, months = 12) {
  const terms = checkLeaseTerms({
    startDate: '2026-11-01',
    endDate: new Date(Date.UTC(2026, 10 + months, 0)).toISOString().slice(0, 10),
    monthlyRentMinor: 150_000,
    cycle: 'monthly',
    noticeDays: 30,
    use: 'residential',
  });
  const schedule: ScheduleRow[] = rentSchedule(terms).map((p) => ({
    id: `cp-${p.sequence}`,
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
  for (const c of cyclesToIssue(cycles, today, new Set()))
    model.issue(invoiceLinesFor(c, null), c.dueDate, c.cycleStart);
  model.accrueTo(today);
  return model;
}

describe('AR-04 early termination', () => {
  it('credits the unused days of the current month, by the day', () => {
    const model = monthlyLease('2026-12-02');
    const credits = unusedDaysCredits(model.lines, model.allocations, '2026-12-10');
    expect(credits).toEqual([
      expect.objectContaining({ unusedDays: 21, periodDays: 31, creditMinor: 101_613 }),
    ]);
  });

  it('applies credit to open lines oldest first, then refunds what is left less deductions', () => {
    const model = monthlyLease('2026-12-02');
    model.pay(150_000 * 6);
    // Release the money paid towards December, as a credit note would on an early end.
    const december = model.lines.find((l) => l.periodStart === '2026-12-01');
    if (!december) throw new Error('line');
    model.creditNote(december.id, 150_000, 'early-end');
    const result = applyCreditToOpenLines(
      model.lines,
      model.allocations,
      creditPools(model.payments, model.allocations),
    );
    expect(result.applications).toEqual([]);
    expect(result.creditLeftMinor).toBe(150_000 * 5);
    expect(refundDue(result.creditLeftMinor, 50_000)).toBe(150_000 * 5 - 50_000);
    expect(() => refundDue(1, 2)).toThrow(/cannot exceed/);
  });
});

describe('AR-05 months paid ahead', () => {
  it('counts whole months covered after the value date (worked example A: 24)', () => {
    const model = monthlyLease('2026-10-25', 24);
    model.pay(150_000 * 24);
    expect(monthsPaidAhead(model.walk(), '2026-10-25')).toBe(24);
    expect(monthsPaidAhead(model.walk(), '2026-11-05')).toBe(23);
  });

  it('under block, allows at most what pays the cap ahead', () => {
    const model = monthlyLease('2026-11-03');
    expect(
      maxPaymentWithinCap({
        walk: model.walk(),
        valueDate: '2026-11-03',
        limitMonths: 6,
        otherDueMinor: 0,
      }),
    ).toBe(150_000 * 7);
  });
});

describe('M5 posting rules balance', () => {
  it('P17, P18, P19, P20, P24, P13 and P33 each balance in the owner’s book', () => {
    const entries = [
      rentTaxLines({
        bookId: 'b',
        lease,
        paymentId: 'p1',
        lines: [
          { invoiceLineId: 'l1', taxMinor: 12_000 },
          { invoiceLineId: null, taxMinor: 0 },
        ],
      }),
      graPaymentLines({
        bookId: 'b',
        from: '1010',
        items: [{ paymentId: 'p1', amountMinor: 12_000 }],
      }),
      withholdingLines({
        bookId: 'b',
        lease,
        paymentId: 'p2',
        lines: [{ invoiceLineId: 'l2', amountMinor: 150_000 }],
      }),
      certificateLines({
        bookId: 'b',
        lease,
        paymentId: 'p2',
        debit: '2200',
        amountMinor: 150_000,
      }),
      withholdingWriteOffLines({ bookId: 'b', lease, paymentId: 'p2', amountMinor: 1 }),
      creditApplicationLines({
        bookId: 'b',
        lease,
        applications: [{ invoiceLineId: 'l3', draws: [{ paymentId: 'p3', amountMinor: 500 }] }],
      }),
      refundApprovedLines({ bookId: 'b', lease, credits: [{ paymentId: 'p3', amountMinor: 700 }] }),
      refundPaidLines({ bookId: 'b', lease, from: '1070', amountMinor: 700 }),
      vatPaymentLines({ bookId: 'b', from: '1010', amountMinor: 30_000 }),
    ];
    for (const lines of entries) checkEntry(lines, owner);
    const all = entries.flat();
    // Worked example B: the withholding settles the tax.
    expect(balanceOf(all, { accountCode: '1150' })).toBe(-1);
    expect(balanceOf(all, { accountCode: '2400' })).toBe(0);
  });
});
