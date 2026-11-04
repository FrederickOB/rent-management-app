import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advancePaymentCapMinor } from '../billing/advance-cap';
import { withholdingDrawsFor } from '../billing/allocation';
import { planWithholding } from '../billing/corrections';
import type { AllocationRow, BillingLine } from '../billing/lines';
import { refundCredits } from '../billing/termination';
import { ScenarioRunner, VAT_RATES, type ScenarioLease } from '../billing/testing/scenarios';
import { addDays, addMonths, parseBusinessDate, toIsoDate } from '../dates';
import { money, multiplyBps } from '../money/money';
import { checkLeaseTerms, rentSchedule } from '../tenancy';
import { receiptTax, receiptTaxBase, type TaxPeriod } from './rent-tax';
import { certificateDebitFor, checkWithholding } from './withholding';

/** Regression tests for the M5 review's domain findings, named after their requirements. */

describe('TX-04 P20 follows the rent tax recorded with the withholding (M5 review 1)', () => {
  it('settles 2200 only when P17 accrued the amount withheld, whatever the owner is today', () => {
    expect(certificateDebitFor({ accruedToRentTax: true })).toBe('2200');
    expect(certificateDebitFor({ accruedToRentTax: false })).toBe('1160');
  });
});

const line = (over: Partial<BillingLine> & { id: string }): BillingLine => ({
  kind: 'rent',
  amountMinor: 1_000_000,
  dueDate: '2026-11-01',
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  accrued: true,
  baseLineId: null,
  rateBps: null,
  chargedOn: null,
  sequence: 1,
  ...over,
});

describe('TX-04 withholding on a month the tenant already paid (M5 review 2)', () => {
  it('lets the withholding reach the cash on the line, and moves that cash back to its payment’s credit', () => {
    const paid = line({ id: 'l1' });
    const allocations: AllocationRow[] = [
      { lineId: 'l1', source: 'payment', paymentId: 'p1', amountMinor: 1_000_000 },
    ];
    // The check accepts it: still owed plus the cash on the line.
    expect(
      checkWithholding(
        [
          {
            lineId: 'l1',
            netMinor: 1_000_000,
            outstandingMinor: 0,
            releasableMinor: 1_000_000,
            withheldMinor: 150_000,
          },
        ],
        1500,
      ).totalMinor,
    ).toBe(150_000);
    const plan = planWithholding({
      lines: [paid],
      allocations,
      payments: [{ id: 'p1', amountMinor: 1_000_000, order: 'a' }],
      withheld: [{ lineId: 'l1', amountMinor: 150_000 }],
      paymentId: null,
    });
    expect(plan.released).toEqual([{ paymentId: 'p1', amountMinor: 150_000 }]);
    expect(plan.rows).toEqual([
      { lineId: 'l1', source: 'payment', paymentId: 'p1', amountMinor: -150_000 },
      { lineId: 'l1', source: 'withholding', paymentId: null, amountMinor: 150_000 },
    ]);
    expect(plan.lines[0]).toMatchObject({ prepaid: false, amountMinor: 150_000 });
  });

  it('takes the cash of the payment paid net first, then the latest payment, never more than the line holds', () => {
    const paid = line({ id: 'l1', accrued: false });
    const allocations: AllocationRow[] = [
      { lineId: 'l1', source: 'payment', paymentId: 'old', amountMinor: 600_000 },
      { lineId: 'l1', source: 'payment', paymentId: 'new', amountMinor: 400_000 },
    ];
    const payments = [
      { id: 'old', amountMinor: 600_000, order: 'a' },
      { id: 'new', amountMinor: 400_000, order: 'b' },
    ];
    const net = planWithholding({
      lines: [paid],
      allocations,
      payments,
      withheld: [{ lineId: 'l1', amountMinor: 700_000 }],
      paymentId: 'old',
    });
    expect(net.lines[0]!.released).toEqual([
      { paymentId: 'old', amountMinor: 600_000 },
      { paymentId: 'new', amountMinor: 100_000 },
    ]);
    expect(net.lines[0]!.prepaid).toBe(true);
    const latest = planWithholding({
      lines: [paid],
      allocations,
      payments,
      withheld: [{ lineId: 'l1', amountMinor: 150_000 }],
      paymentId: null,
    });
    expect(latest.released).toEqual([{ paymentId: 'new', amountMinor: 150_000 }]);
    expect(() =>
      planWithholding({
        lines: [paid],
        allocations,
        payments,
        withheld: [{ lineId: 'l1', amountMinor: 1_000_001 }],
        paymentId: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'withholding.too_large' }));
  });

  it('draws each withholding held as a month’s advance on its own key when the month accrues', () => {
    const rows: AllocationRow[] = [
      { lineId: 'l1', source: 'withholding', paymentId: null, amountMinor: 100, recordId: 'w1' },
      { lineId: 'l1', source: 'withholding', paymentId: null, amountMinor: 50, recordId: 'w2' },
      { lineId: 'l1', source: 'payment', paymentId: 'p1', amountMinor: -30, recordId: 'w2' },
      { lineId: 'l2', source: 'withholding', paymentId: null, amountMinor: 70, recordId: 'w1' },
    ];
    expect(withholdingDrawsFor('l1', rows)).toEqual([
      { withholdingId: 'w1', amountMinor: 100 },
      { withholdingId: 'w2', amountMinor: 50 },
    ]);
  });
});

describe('AR-04 a refund is shared first in, first out by payment (M5 review 5)', () => {
  it('takes the oldest credit first and refuses more than the lease holds', () => {
    const pools = [
      { paymentId: 'a', amountMinor: 300 },
      { paymentId: 'b', amountMinor: 500 },
    ];
    expect(refundCredits(pools, 600)).toEqual([
      { paymentId: 'a', amountMinor: 300 },
      { paymentId: 'b', amountMinor: 300 },
    ]);
    expect(() => refundCredits(pools, 801)).toThrow(
      expect.objectContaining({ code: 'termination.refund_over_credit' }),
    );
  });
});

describe('TX-01 a receipt’s tax is rounded half up once, unless its months’ caps bind (M5 review 6)', () => {
  it('equals half up of base × rate exactly, or, when that would put a month over the rate on its amount, all the room the months have', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 24 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 24, maxLength: 24 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 24, maxLength: 24 }),
        fc.constantFrom(800, 1500),
        (amounts, taxedPercent, coveredPercent, rate) => {
          const periods: TaxPeriod[] = amounts.map((amount, i) => {
            const taxed = Math.floor((amount * (taxedPercent[i] ?? 0)) / 100);
            const covered = Math.max(
              taxed,
              Math.floor((amount * (coveredPercent[i] ?? 100)) / 100),
            );
            return {
              key: `p${i}`,
              kind: 'rent' as const,
              amountMinor: amount,
              coveredMinor: covered,
              taxedBaseMinor: taxed,
              taxMinor: multiplyBps(money(taxed), rate).amountMinor,
              withheld: false,
            };
          });
          const { baseMinor, pins } = receiptTaxBase(periods, { includesServiceCharge: true });
          const tax = receiptTax(pins, periods, rate);
          const exact = multiplyBps(money(baseMinor), rate).amountMinor;
          // The months' room: the rate on each amount (half up), less the tax already on it.
          const room = pins.reduce((sum, pin) => {
            const p = periods.find((x) => x.key === pin.key)!;
            return (
              sum + Math.max(0, multiplyBps(money(p.amountMinor), rate).amountMinor - p.taxMinor)
            );
          }, 0);
          expect(tax.taxMinor).toBe(Math.min(exact, room));
          expect(tax.lines.reduce((s, l) => s + l.taxMinor, 0)).toBe(tax.taxMinor);
        },
      ),
    );
  });
});

/** A VAT-registered commercial lease, monthly, a year long, starting today. */
function vatLease(start: string): ScenarioLease {
  const end = toIsoDate(addDays(addMonths(parseBusinessDate(start), 12), -1));
  const terms = checkLeaseTerms({
    startDate: start,
    endDate: end,
    monthlyRentMinor: 1_000_000,
    cycle: 'monthly',
    noticeDays: 30,
    use: 'commercial',
  });
  return {
    terms,
    schedule: rentSchedule(terms).map((p) => ({
      id: `cp-${p.chargeType}-${p.sequence}`,
      sequence: p.sequence,
      chargeType: p.chargeType,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      amountMinor: p.amountMinor,
      source: 'schedule' as const,
    })),
    vat: VAT_RATES,
  };
}

describe('AR-05 one advance cap for the pay page, cash and transfers (M5 review 9)', () => {
  it('counts months of rent against the limit and carries their VAT and levies with them', () => {
    const run = new ScenarioRunner(vatLease('2026-11-21'));
    for (let i = 0; i < 20; i += 1) run.apply({ kind: 'days', days: 1 });
    const m = run.model;
    const cap = advancePaymentCapMinor({
      lines: m.lines,
      allocations: m.allocations,
      walk: m.walk(),
      valueDate: m.today,
      limitMonths: 6,
    });
    // This month and six ahead, each GH₵10,000 rent with 15% VAT, 2.5% NHIL and 2.5% GETFund.
    expect(cap).toBe(7 * (1_000_000 + 150_000 + 25_000 + 25_000));
    // Paying exactly that puts six months ahead, not more.
    m.pay(cap);
    const ahead = new Set(
      m
        .walk()
        .lines.filter((l) => l.periodStart > m.today && l.periodEnd <= m.walk().paidUntil!)
        .map((l) => l.periodStart),
    );
    expect(ahead.size).toBe(6);
  });
});
