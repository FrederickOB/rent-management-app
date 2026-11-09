import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { money, multiplyFraction, multiplyRatio } from './money';

describe('ADR-004 one rounding for a product of ratios (M10 proration)', () => {
  it('multiplies every factor, divides once and rounds half up on the magnitude', () => {
    // 12 units × GH₵15.00 × 17 / 30 days = GH₵10,200 exactly.
    expect(multiplyFraction(money(1_500), [12, 17], [30]).amountMinor).toBe(10_200);
    // 1 × GH₵0.05 × 1 / 2 = 2.5 pesewas: half up to 3, and -3 for a credit.
    expect(multiplyFraction(money(5), [1], [2]).amountMinor).toBe(3);
    expect(multiplyFraction(money(-5), [1], [2]).amountMinor).toBe(-3);
    // A 10% annual discount: 30 units × GH₵8 × 31/31 × 9,000 / 10,000.
    expect(multiplyFraction(money(800), [30, 31, 9_000], [31, 10_000]).amountMinor).toBe(21_600);
    // No factors is the amount itself.
    expect(multiplyFraction(money(1_234), [], []).amountMinor).toBe(1_234);
  });

  it('refuses fractions, a zero or negative denominator, and a result past the safe range', () => {
    expect(() => multiplyFraction(money(100), [1.5], [2])).toThrow(/whole numbers/);
    expect(() => multiplyFraction(money(100), [1], [0])).toThrow(/positive/);
    expect(() => multiplyFraction(money(100), [1], [-3])).toThrow(/positive/);
    expect(() =>
      multiplyFraction(money(Number.MAX_SAFE_INTEGER), [Number.MAX_SAFE_INTEGER], [1]),
    ).toThrow(/safe integer/);
  });

  it('never overflows in between: a huge product divided back is exact', () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(multiplyFraction(money(big), [big, 3], [big, 3]).amountMinor).toBe(big);
  });

  it('agrees with multiplyRatio for one factor', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (a, n, d) => {
          expect(multiplyFraction(money(a), [n], [d]).amountMinor).toBe(
            multiplyRatio(money(a), n, d).amountMinor,
          );
        },
      ),
    );
  });

  it('is within half a pesewa of the exact value, and commutes with negation', () => {
    fc.assert(
      fc.property(
        // The result stays a safe integer: at most 1e6 × 1e3 × 1e3 × 1e3 pesewas.
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 1_000 }), { maxLength: 3 }),
        fc.array(fc.integer({ min: 1, max: 100_000 }), { maxLength: 3 }),
        (a, ns, ds) => {
          const num = ns.reduce((acc, n) => acc * BigInt(n), BigInt(a));
          const den = ds.reduce((acc, d) => acc * BigInt(d), 1n);
          const result = BigInt(multiplyFraction(money(a), ns, ds).amountMinor);
          const twiceError = 2n * result * den - 2n * num; // 2 × den × (result - exact)
          expect(twiceError <= den && twiceError >= -den).toBe(true);
          expect(multiplyFraction(money(-a), ns, ds).amountMinor).toBe(-Number(result) || 0);
        },
      ),
    );
  });
});
