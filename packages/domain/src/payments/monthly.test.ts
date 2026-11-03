import { describe, expect, it } from 'vitest';
import { checkLeaseTerms, type LeaseTermsInput } from '../tenancy/lease-terms';
import { rentSchedule } from '../tenancy/schedule';
import { monthlyChargeMinor } from './matching';

/**
 * BC-12 the queue's "a month of its rent" reason (M4b web e2e: a rent-only lease's month was
 * the last two periods added together, so GH₵800 never matched a GH₵800 month).
 */
const base: LeaseTermsInput = {
  startDate: '2026-08-15',
  endDate: '2027-08-14',
  monthlyRentMinor: 80_000,
  cycle: 'monthly',
  noticeDays: 30,
  use: 'residential',
};

const month = (input: Partial<LeaseTermsInput>, today: string) => {
  const terms = checkLeaseTerms({ ...base, ...input });
  return monthlyChargeMinor(rentSchedule(terms), terms, today);
};

describe('BC-12 a month of a lease, as billed now', () => {
  it('is one month’s rent for a rent-only lease, however many months have started', () => {
    expect(month({}, '2026-11-20')).toBe(80_000);
    expect(month({}, '2026-08-15')).toBe(80_000);
  });

  it('is the month’s rent and service charge together', () => {
    expect(month({ serviceChargeMonthlyMinor: 20_000 }, '2026-11-20')).toBe(100_000);
  });

  it('is still one month on a quarterly or annual cycle (charge periods are monthly)', () => {
    expect(month({ cycle: 'quarterly' }, '2026-11-20')).toBe(80_000);
    expect(month({ cycle: 'annual', serviceChargeMonthlyMinor: 20_000 }, '2027-02-01')).toBe(
      100_000,
    );
  });

  it('follows an escalation from its period', () => {
    const steps = [{ effectiveFrom: '2027-02-15', monthlyRentMinor: 90_000 }];
    expect(month({ steps }, '2027-02-14')).toBe(80_000);
    expect(month({ steps }, '2027-02-15')).toBe(90_000);
    expect(month({ steps, serviceChargeMonthlyMinor: 20_000 }, '2027-03-01')).toBe(110_000);
  });

  it('is a full month during a short final period, which is charged by the day', () => {
    const short = { endDate: '2027-08-31', serviceChargeMonthlyMinor: 20_000 };
    expect(month(short, '2027-08-20')).toBe(100_000);
    expect(month(short, '2027-08-14')).toBe(100_000);
  });

  it('is the first month before the lease starts, and nothing without a schedule', () => {
    expect(month({}, '2026-07-01')).toBe(80_000);
    expect(monthlyChargeMinor([], checkLeaseTerms(base), '2026-11-20')).toBe(0);
  });
});
