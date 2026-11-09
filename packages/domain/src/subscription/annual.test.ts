import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { annualPrice, annualTerm, inAnnualTerm, prepaidDraw } from './annual';

/** VAT rates are inputs from the rules table (decision 10); these are only numbers for the test. */
const TEST_VAT = { vatBps: 1_500, nhilBps: 250, getfundBps: 250 };

describe('PB-05 annual prepayment (decision 7)', () => {
  it('charges 12 months less the annual discount, floored at 12 × the minimum', () => {
    expect(
      annualPrice({
        monthlyNetMinor: 18_000,
        minimumMinor: 15_000,
        annualDiscountBps: 1_000,
        vat: null,
      }),
    ).toEqual({ netMinor: 194_400, vatMinor: 0, totalMinor: 194_400 });
    expect(
      annualPrice({
        monthlyNetMinor: 10_000,
        minimumMinor: 15_000,
        annualDiscountBps: 1_000,
        vat: null,
      }),
    ).toEqual({ netMinor: 180_000, vatMinor: 0, totalMinor: 180_000 });
    // 12 × GH₵0.07 × 90% = 75.6 pesewas: rounded once to 76, above a zero minimum.
    expect(
      annualPrice({ monthlyNetMinor: 7, minimumMinor: 0, annualDiscountBps: 1_000, vat: null })
        .netMinor,
    ).toBe(76);
  });

  it('adds VAT and levies on top only when charged', () => {
    expect(
      annualPrice({
        monthlyNetMinor: 18_000,
        minimumMinor: 15_000,
        annualDiscountBps: 1_000,
        vat: TEST_VAT,
      }),
    ).toEqual({ netMinor: 194_400, vatMinor: 29_160 + 4_860 + 4_860, totalMinor: 233_280 });
  });

  it('refuses a negative amount or a discount past 100%', () => {
    expect(() =>
      annualPrice({ monthlyNetMinor: -1, minimumMinor: 0, annualDiscountBps: 0, vat: null }),
    ).toThrow(/zero or more/);
    expect(() =>
      annualPrice({ monthlyNetMinor: 1, minimumMinor: 0, annualDiscountBps: 10_001, vat: null }),
    ).toThrow(/basis points/);
  });

  it('runs 12 billing months from the month of purchase', () => {
    expect(annualTerm('2026-11')).toEqual({
      startsOn: '2026-11-01',
      endsOn: '2027-10-31',
      firstMonth: '2026-11',
      lastMonth: '2027-10',
    });
    const term = annualTerm('2026-11');
    expect(['2026-10', '2026-11', '2027-10', '2027-11'].map((m) => inAnnualTerm(term, m))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(inAnnualTerm(null, '2026-11')).toBe(false);
  });

  it('draws each invoice from prepaid credit first; the shortfall stays owed', () => {
    expect(prepaidDraw(10_000, 18_000)).toEqual({
      drawMinor: 10_000,
      shortfallMinor: 8_000,
      creditLeftMinor: 0,
    });
    expect(prepaidDraw(50_000, 18_000)).toEqual({
      drawMinor: 18_000,
      shortfallMinor: 0,
      creditLeftMinor: 32_000,
    });
    expect(prepaidDraw(0, 0)).toEqual({ drawMinor: 0, shortfallMinor: 0, creditLeftMinor: 0 });
    expect(() => prepaidDraw(-1, 5)).toThrow(/zero or more/);
  });

  it('never floors below 12 × the minimum, and is otherwise the discounted year rounded once', () => {
    fc.assert(
      fc.property(
        fc.nat(10_000_000),
        fc.nat(1_000_000),
        fc.nat(10_000),
        (monthly, minimum, bps) => {
          const { netMinor, vatMinor, totalMinor } = annualPrice({
            monthlyNetMinor: monthly,
            minimumMinor: minimum,
            annualDiscountBps: bps,
            vat: null,
          });
          expect(netMinor).toBeGreaterThanOrEqual(12 * minimum);
          expect(vatMinor).toBe(0);
          expect(totalMinor).toBe(netMinor);
          if (netMinor > 12 * minimum) {
            const num = 12n * BigInt(monthly) * BigInt(10_000 - bps);
            const twiceError = 2n * BigInt(netMinor) * 10_000n - 2n * num;
            expect(twiceError <= 10_000n && twiceError >= -10_000n).toBe(true);
          }
        },
      ),
    );
  });

  it('draws a year of invoices from the credit: draws and what is left add up, shortfalls only once it is gone', () => {
    fc.assert(
      fc.property(
        fc.nat(5_000_000),
        fc.array(fc.nat(1_000_000), { minLength: 1, maxLength: 14 }),
        (credit, invoices) => {
          let left = credit;
          let drawn = 0;
          let short = 0;
          for (const total of invoices) {
            const draw = prepaidDraw(left, total);
            expect(draw.drawMinor + draw.shortfallMinor).toBe(total);
            expect(draw.drawMinor + draw.creditLeftMinor).toBe(left);
            expect(draw.drawMinor).toBe(Math.min(left, total));
            if (draw.shortfallMinor > 0) expect(draw.creditLeftMinor).toBe(0);
            left = draw.creditLeftMinor;
            drawn += draw.drawMinor;
            short += draw.shortfallMinor;
          }
          expect(drawn + left).toBe(credit);
          expect(drawn + short).toBe(invoices.reduce((a, b) => a + b, 0));
        },
      ),
    );
  });
});
