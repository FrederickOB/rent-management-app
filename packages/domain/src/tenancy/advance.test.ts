import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advanceOutcome, checkAdvance, monthsDemandedInAdvance } from './advance';
import { CYCLE_MONTHS, RENT_CYCLES } from './lease-terms';

const terms = fc.record({
  cycle: fc.constantFrom(...RENT_CYCLES),
  initialAdvanceMonths: fc.option(fc.integer({ min: 1, max: 600 }), { nil: null }),
  periodCount: fc.integer({ min: 1, max: 600 }),
});
const limit = fc.option(fc.integer({ min: 0, max: 60 }), { nil: null });
const rules = fc.record({ monthlyOrShorter: limit, overSixMonths: limit });

describe('AR-05 advance check (property-based)', () => {
  it('demands the larger of the cycle and the initial advance, never less than one cycle', () => {
    fc.assert(
      fc.property(terms, (t) => {
        const months = monthsDemandedInAdvance(t);
        expect(months).toBe(Math.max(CYCLE_MONTHS[t.cycle], t.initialAdvanceMonths ?? 0));
        expect(months).toBeGreaterThanOrEqual(CYCLE_MONTHS[t.cycle]);
      }),
    );
  });

  it('applies the one-month rule up to a month, the six-month rule beyond six, none between', () => {
    fc.assert(
      fc.property(terms, rules, (t, r) => {
        const check = checkAdvance(t, r);
        const expected =
          t.periodCount <= 1 ? 'monthly_or_shorter' : t.periodCount > 6 ? 'over_six_months' : null;
        expect(check.rule).toBe(expected);
        expect(check.limitMonths).toBe(
          expected === 'monthly_or_shorter'
            ? r.monthlyOrShorter
            : expected === 'over_six_months'
              ? r.overSixMonths
              : null,
        );
        expect(check.exceedsLimit).toBe(
          check.limitMonths !== null && check.monthsDemanded > check.limitMonths,
        );
      }),
    );
  });

  it('never flags or refuses under off, never refuses under warn, refuses only over a limit', () => {
    fc.assert(
      fc.property(terms, rules, (t, r) => {
        const check = checkAdvance(t, r);
        expect(advanceOutcome(check, 'off')).toEqual({ flag: false, refuse: false });
        expect(advanceOutcome(check, 'warn')).toEqual({
          flag: check.exceedsLimit,
          refuse: false,
        });
        expect(advanceOutcome(check, 'block')).toEqual({
          flag: check.exceedsLimit,
          refuse: check.exceedsLimit,
        });
      }),
    );
  });

  it('never calls an advance compliant', () => {
    fc.assert(
      fc.property(terms, rules, (t, r) => {
        expect(JSON.stringify(checkAdvance(t, r)).toLowerCase()).not.toContain('complian');
      }),
    );
  });
});
