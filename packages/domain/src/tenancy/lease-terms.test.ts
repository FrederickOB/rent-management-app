import { describe, expect, it } from 'vitest';
import { advanceOutcome, checkAdvance, monthsDemandedInAdvance } from './advance';
import { checkLeaseTerms, type LeaseTermsInput } from './lease-terms';
import { checkLeaseTransition, occupancyFor } from './lease-states';

const base: LeaseTermsInput = {
  startDate: '2026-11-01',
  endDate: '2027-10-31',
  monthlyRentMinor: 150_000,
  cycle: 'monthly',
  noticeDays: 30,
  use: 'residential',
};

describe('TL-06 lease terms', () => {
  it('normalises valid terms and counts the rent periods', () => {
    const terms = checkLeaseTerms({ ...base, depositMinor: 0, cycle: 'annual' });
    expect(terms).toMatchObject({
      periodCount: 12,
      depositMinor: null,
      initialAdvanceMonths: null,
    });
  });

  it('refuses dates, amounts, cycles and advances that do not fit', () => {
    expect(() => checkLeaseTerms({ ...base, endDate: '2026-11-01' })).toThrow(
      /end after it starts/,
    );
    expect(() => checkLeaseTerms({ ...base, endDate: '2026-31-01' })).toThrow(/Not a date/);
    expect(() => checkLeaseTerms({ ...base, monthlyRentMinor: 0 })).toThrow(/rent/);
    expect(() => checkLeaseTerms({ ...base, monthlyRentMinor: 1500.5 })).toThrow(/rent/);
    expect(() => checkLeaseTerms({ ...base, endDate: '2027-02-28', cycle: 'six_monthly' })).toThrow(
      /longer than the lease/,
    );
    expect(() => checkLeaseTerms({ ...base, cycle: 'quarterly', initialAdvanceMonths: 2 })).toThrow(
      /advance/,
    );
    expect(() => checkLeaseTerms({ ...base, initialAdvanceMonths: 13 })).toThrow(/advance/);
    expect(() => checkLeaseTerms({ ...base, depositMinor: -1 })).toThrow(/deposit/);
    expect(() => checkLeaseTerms({ ...base, noticeDays: -5 })).toThrow(/notice/);
  });

  it('accepts escalation steps only on later rent periods, in order', () => {
    const step = (effectiveFrom: string) => ({ effectiveFrom, monthlyRentMinor: 165_000 });
    expect(checkLeaseTerms({ ...base, steps: [step('2027-05-01')] }).steps).toHaveLength(1);
    expect(() => checkLeaseTerms({ ...base, steps: [step('2027-05-15')] })).toThrow(/rent period/);
    expect(() => checkLeaseTerms({ ...base, steps: [step('2026-11-01')] })).toThrow(/rent period/);
    expect(() => checkLeaseTerms({ ...base, steps: [step('2027-11-01')] })).toThrow(/rent period/);
    expect(() =>
      checkLeaseTerms({ ...base, steps: [step('2027-05-01'), step('2027-05-01')] }),
    ).toThrow(/rent period/);
  });

  it('checks the break clause', () => {
    const breakClause = {
      fromDate: '2027-05-01',
      party: 'tenant' as const,
      noticeDays: 60,
      creditUnusedDays: true,
    };
    expect(checkLeaseTerms({ ...base, breakClause }).breakClause).toEqual(breakClause);
    expect(() =>
      checkLeaseTerms({ ...base, breakClause: { ...breakClause, fromDate: '2028-01-01' } }),
    ).toThrow(/during the lease/);
  });
});

describe('AR-05 advance check', () => {
  const rules = { monthlyOrShorter: 1, overSixMonths: 6 };

  it('counts the months demanded in advance from the cycle or the initial advance', () => {
    expect(monthsDemandedInAdvance({ cycle: 'monthly', initialAdvanceMonths: null })).toBe(1);
    expect(monthsDemandedInAdvance({ cycle: 'annual', initialAdvanceMonths: null })).toBe(12);
    expect(monthsDemandedInAdvance({ cycle: 'monthly', initialAdvanceMonths: 24 })).toBe(24);
  });

  it('applies the over-six-months rule to longer terms and none in between (OQ-51)', () => {
    const twoYears = checkLeaseTerms({ ...base, endDate: '2028-10-31', initialAdvanceMonths: 24 });
    expect(checkAdvance(twoYears, rules)).toEqual({
      monthsDemanded: 24,
      rule: 'over_six_months',
      limitMonths: 6,
      exceedsLimit: true,
    });
    expect(checkAdvance(checkLeaseTerms(base), rules).exceedsLimit).toBe(false);
    const fourMonths = checkLeaseTerms({ ...base, endDate: '2027-02-28', cycle: 'quarterly' });
    expect(checkAdvance(fourMonths, rules)).toMatchObject({ rule: null, exceedsLimit: false });
    const oneMonth = checkLeaseTerms({ ...base, endDate: '2026-11-30' });
    expect(checkAdvance(oneMonth, rules)).toMatchObject({
      rule: 'monthly_or_shorter',
      exceedsLimit: false,
    });
  });

  it('records only under off, flags under warn, refuses under block', () => {
    const over = checkAdvance(checkLeaseTerms({ ...base, cycle: 'annual' }), rules);
    expect(advanceOutcome(over, 'off')).toEqual({ flag: false, refuse: false });
    expect(advanceOutcome(over, 'warn')).toEqual({ flag: true, refuse: false });
    expect(advanceOutcome(over, 'block')).toEqual({ flag: true, refuse: true });
    const under = checkAdvance(checkLeaseTerms(base), rules);
    expect(advanceOutcome(under, 'block')).toEqual({ flag: false, refuse: false });
  });
});

describe('PB-09 lease states and occupancy', () => {
  it('follows the lease state machine', () => {
    expect(() => checkLeaseTransition('draft', 'pending_signatures')).not.toThrow();
    expect(() => checkLeaseTransition('pending_signatures', 'signed')).not.toThrow();
    expect(() => checkLeaseTransition('signed', 'active')).not.toThrow();
    expect(() => checkLeaseTransition('active', 'holding_over')).not.toThrow();
    expect(() => checkLeaseTransition('holding_over', 'ended')).not.toThrow();
    expect(() => checkLeaseTransition('active', 'draft')).toThrow(/cannot become/);
    expect(() => checkLeaseTransition('ended', 'active')).toThrow(/cannot become/);
    expect(() => checkLeaseTransition('signed', 'ended')).toThrow(/cannot become/);
  });

  it('derives occupancy from leases', () => {
    expect(occupancyFor([])).toBe('vacant');
    expect(occupancyFor(['ended', 'signed'])).toBe('reserved');
    expect(occupancyFor(['signed', 'active'])).toBe('occupied');
    expect(occupancyFor(['holding_over'])).toBe('occupied');
    expect(occupancyFor(['cancelled', 'terminated', 'draft'])).toBe('vacant');
  });
});
