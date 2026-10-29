import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  format,
  money,
  multiplyBps,
  negate,
  parseAmount,
  splitEvenly,
  subtract,
  sum,
} from './money';

const amount = fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 });

describe('NFR-LOC money', () => {
  it('rejects non-integer amounts', () => {
    expect(() => money(1.5)).toThrow();
    expect(() => money(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it('adds and subtracts exactly', () => {
    fc.assert(
      fc.property(amount, amount, (a, b) => {
        expect(subtract(add(money(a), money(b)), money(b)).amountMinor).toBe(a);
      }),
    );
  });

  it('multiplies by basis points with half-up rounding applied once', () => {
    expect(multiplyBps(money(150_000), 800).amountMinor).toBe(12_000); // 8% of GH₵1,500
    expect(multiplyBps(money(1), 5_000).amountMinor).toBe(1); // 0.5 rounds up
    expect(multiplyBps(money(3), 1_500).amountMinor).toBe(0); // 0.45 rounds down
    expect(multiplyBps(money(-1), 5_000).amountMinor).toBe(-1); // magnitude rounding
    fc.assert(
      fc.property(amount, fc.integer({ min: 0, max: 100_000 }), (a, bps) => {
        const exact = (BigInt(a) * BigInt(bps) * 2n) / 10_000n; // twice the exact value, truncated
        const result = BigInt(multiplyBps(money(a), bps).amountMinor);
        // |result - exact/2| <= 0.5
        expect(result * 2n - exact).toBeLessThanOrEqual(1n);
        expect(result * 2n - exact).toBeGreaterThanOrEqual(-1n);
        expect(multiplyBps(negate(money(a)), bps).amountMinor).toBe(
          -result === 0n ? 0 : Number(-result),
        );
      }),
    );
  });

  it('splits by largest remainder so the parts always sum to the total', () => {
    fc.assert(
      fc.property(
        amount,
        fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 1, maxLength: 40 }),
        (a, weights) => {
          fc.pre(weights.some((w) => w > 0));
          const parts = allocate(money(a), weights);
          expect(sum(parts).amountMinor).toBe(a);
          weights.forEach((w, i) => {
            if (w === 0) expect(parts[i]?.amountMinor).toBe(0);
          });
        },
      ),
    );
  });

  it('gives leftover pesewas to the earliest parts (ADR-004 example)', () => {
    const months = splitEvenly(money(1_000_000), 12);
    expect(months.map((m) => m.amountMinor)).toEqual([
      83_334, 83_334, 83_334, 83_334, 83_333, 83_333, 83_333, 83_333, 83_333, 83_333, 83_333,
      83_333,
    ]);
  });

  it('formats for display and parses user input exactly', () => {
    expect(format(money(150_000))).toBe('GH₵1,500.00');
    expect(format(money(-7))).toBe('-GH₵0.07');
    expect(format(money(123_456_789))).toBe('GH₵1,234,567.89');
    expect(parseAmount('1,500.5').amountMinor).toBe(150_050);
    expect(parseAmount('0.07').amountMinor).toBe(7);
    expect(() => parseAmount('1.234')).toThrow();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), (a) => {
        const text = format(money(a)).replace('GH₵', '');
        expect(parseAmount(text).amountMinor).toBe(a);
      }),
    );
  });
});
