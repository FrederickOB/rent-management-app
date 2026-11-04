import { describe, expect, it } from 'vitest';
import { checkEntry } from '../ledger/journal';
import { accrualLines } from '../ledger/posting';
import { withholdingDrawLines, withholdingLines } from '../ledger/tax-posting';
import { planAccrual, withheldOn } from './allocation';
import type { AllocationRow, BillingLine } from './lines';

/**
 * M5 decision 8 (founder, 2026-11-03): withholding on a month not yet started is held as its
 * advance (Dr 1150, Cr 2010 on the line) and drawn on its own key when the month starts (Dr 2010,
 * Cr 1100), beside the month's P02. Worked example B's month, in advance.
 */
const lease = { propertyId: 'p', unitId: 'u', leaseId: 'l', tenantId: 't' };
const book = 'book';
const line: BillingLine = {
  id: 'dec',
  kind: 'rent',
  baseLineId: null,
  rateBps: null,
  dueDate: '2026-11-15',
  periodStart: '2026-12-01',
  periodEnd: '2026-12-31',
  amountMinor: 1_000_000,
  accrued: false,
  sequence: 1,
};
const allocations: AllocationRow[] = [
  { lineId: 'dec', source: 'withholding', paymentId: null, amountMinor: 150_000 },
  { lineId: 'dec', source: 'payment', paymentId: 'p1', amountMinor: 850_000 },
];
const sum = (lines: readonly { accountCode: string; amountMinor: number }[], code: string) =>
  lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.amountMinor, 0);

describe('TX-04 withholding held as an advance (M5 decision 8)', () => {
  it('holds a not-yet-started month’s withholding in prepayments, never in receivables', () => {
    const lines = withholdingLines({
      bookId: book,
      lease,
      paymentId: 'p1',
      lines: [{ invoiceLineId: 'dec', amountMinor: 150_000, prepaid: true }],
    });
    checkEntry(lines, () => 'owner');
    expect([sum(lines, '1150'), sum(lines, '2010'), sum(lines, '1100')]).toEqual([
      150_000, -150_000, 0,
    ]);
    const started = withholdingLines({
      bookId: book,
      lease,
      paymentId: null,
      lines: [{ invoiceLineId: 'dec', amountMinor: 150_000 }],
    });
    expect([sum(started, '1150'), sum(started, '1100')]).toEqual([150_000, -150_000]);
  });

  it('accrues the month in full when it starts, its withholding drawn on its own entry, leaving nothing owed', () => {
    expect(withheldOn('dec', allocations)).toBe(150_000);
    const plan = planAccrual(line, allocations, []);
    expect(plan).toMatchObject({ amountMinor: 1_000_000, owedMinor: 0, draws: [] });
    expect(plan.advance).toEqual([{ paymentId: 'p1', amountMinor: 850_000 }]);
    const p02 = accrualLines({
      bookId: book,
      lease,
      invoiceLineId: 'dec',
      chargeType: 'rent',
      amountMinor: plan.amountMinor,
      advance: plan.advance,
      draws: plan.draws,
    });
    const draw = withholdingDrawLines({
      bookId: book,
      lease,
      invoiceLineId: 'dec',
      amountMinor: 150_000,
    });
    checkEntry(p02, () => 'owner');
    checkEntry(draw, () => 'owner');
    const both = [...p02, ...draw];
    expect(sum(both, '4000')).toBe(-1_000_000);
    expect(sum(both, '2010')).toBe(1_000_000);
    expect(sum(both, '1100')).toBe(0);
  });

  it('still refuses a not-yet-started month holding anything but payments’ and withholding’s advance', () => {
    expect(() =>
      planAccrual(
        line,
        [
          { lineId: 'dec', source: 'withholding', paymentId: null, amountMinor: 150_000 },
          { lineId: 'dec', source: 'write_off', paymentId: null, amountMinor: 1 },
        ],
        [],
      ),
    ).toThrow(/cannot have/);
  });
});
