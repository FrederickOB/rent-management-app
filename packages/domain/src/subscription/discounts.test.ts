import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertRedeemable,
  discountTermsOf,
  monthsLeft,
  normalizeCode,
  redemptionCovers,
  type DiscountCodeFacts,
} from './discounts';
import { shiftMonth } from './pricing';

const code = (over: Partial<DiscountCodeFacts> = {}): DiscountCodeFacts => ({
  code: 'WELCOME20',
  kind: 'percentage',
  percentBps: 2_000,
  amountMinor: null,
  months: 3,
  expiresOn: '2026-12-31',
  maxUses: 100,
  uses: 4,
  ...over,
});

const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code';
  }
};

describe('PB-05 discount codes (decision 8)', () => {
  it('compares codes trimmed and in capitals', () => {
    expect(normalizeCode('  welcome20 ')).toBe('WELCOME20');
    expect(
      discountTermsOf(
        code({ code: ' launch ', kind: 'fixed', percentBps: null, amountMinor: 5_000 }),
      ),
    ).toEqual({
      kind: 'fixed',
      amountMinor: 5_000,
      code: 'LAUNCH',
    });
    expect(discountTermsOf(code())).toEqual({
      kind: 'percentage',
      percentBps: 2_000,
      code: 'WELCOME20',
    });
  });

  it('applies a code until its last day, while it has uses left, one at a time', () => {
    expect(codeOf(() => assertRedeemable(code(), '2026-11-07', false))).toBeNull();
    expect(codeOf(() => assertRedeemable(code(), '2026-12-31', false))).toBeNull();
    expect(
      codeOf(() => assertRedeemable(code({ expiresOn: null, maxUses: null }), '2030-01-01', false)),
    ).toBeNull();
    expect(codeOf(() => assertRedeemable(code(), '2027-01-01', false))).toBe('discount.expired');
    expect(codeOf(() => assertRedeemable(code({ uses: 100 }), '2026-11-07', false))).toBe(
      'discount.used_up',
    );
    expect(
      codeOf(() => assertRedeemable(code({ maxUses: 1, uses: 0 }), '2026-11-07', false)),
    ).toBeNull();
    expect(codeOf(() => assertRedeemable(code(), '2026-11-07', true))).toBe(
      'discount.already_applied',
    );
  });

  it('checks in order: invalid, expired, used up, already applied', () => {
    const everything = code({ expiresOn: '2026-01-01', uses: 100 });
    expect(codeOf(() => assertRedeemable(everything, '2026-11-07', true))).toBe('discount.expired');
    expect(codeOf(() => assertRedeemable(code({ uses: 100 }), '2026-11-07', true))).toBe(
      'discount.used_up',
    );
    expect(codeOf(() => assertRedeemable(code({ percentBps: null }), '2026-11-07', true))).toBe(
      'discount.invalid',
    );
  });

  it('refuses a malformed code', () => {
    for (const bad of [
      code({ percentBps: null }),
      code({ percentBps: 0 }),
      code({ percentBps: 10_001 }),
      code({ amountMinor: 500 }),
      code({ kind: 'fixed', percentBps: null, amountMinor: 0 }),
      code({ kind: 'fixed', percentBps: null, amountMinor: null }),
      code({ kind: 'fixed', percentBps: 1_000, amountMinor: 500 }),
      code({ months: 0 }),
      code({ code: '   ' }),
      code({ maxUses: 0, uses: 0 }),
      code({ kind: 'bogus' as never }),
    ])
      expect(codeOf(() => assertRedeemable(bad, '2026-11-07', false))).toBe('discount.invalid');
  });

  it('covers its billing months from the first, and counts what is left including this month', () => {
    expect(
      ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02'].map((m) =>
        redemptionCovers('2026-11', 3, m),
      ),
    ).toEqual([false, true, true, true, false]);
    expect(
      ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02'].map((m) =>
        monthsLeft('2026-11', 3, m),
      ),
    ).toEqual([3, 3, 2, 1, 0]);
  });

  it('agrees: the months left are the covered months from now on', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: -30, max: 90 }),
        (start, months, offset) => {
          const first = shiftMonth('2026-01', start);
          const now = shiftMonth(first, offset);
          let covered = 0;
          for (let k = 0; k < 120; k += 1)
            if (redemptionCovers(first, months, shiftMonth(now, k))) covered += 1;
          expect(monthsLeft(first, months, now)).toBe(covered);
        },
      ),
    );
  });
});
