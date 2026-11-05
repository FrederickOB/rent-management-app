import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DISPLAY_STATUSES } from '../portfolio/status';
import {
  leaseActiveOn,
  addOccupancy,
  countByStatus,
  occupancyOf,
  paidUntilCoverage,
  rentRoll,
  type RentRollLease,
} from './dashboard';

describe('DA-01 occupancy', () => {
  it('counts occupied units against lettable ones; not lettable units are left out', () => {
    // The Legon compound: 12 rooms, one vacant, one under repair, one not lettable, one reserved.
    expect(
      occupancyOf({ occupied: 8, vacant: 1, under_repair: 1, reserved: 1, not_lettable: 1 }),
    ).toEqual({
      units: 12,
      lettable: 11,
      occupied: 8,
      vacant: 3,
      available: 1,
      reserved: 1,
      underRepair: 1,
      notLettable: 1,
      rate: { numerator: 8, denominator: 11, bps: 7_273 },
    });
  });

  it('is empty for a portfolio with no lettable unit', () => {
    expect(occupancyOf({}).rate.bps).toBeNull();
    expect(occupancyOf({ not_lettable: 2 }).rate).toEqual({
      numerator: 0,
      denominator: 0,
      bps: null,
    });
  });

  it('counts units by status and adds portfolios up', () => {
    const counts = countByStatus([
      { status: 'occupied' },
      { status: 'occupied' },
      { status: 'vacant' },
    ]);
    expect(counts).toEqual({ occupied: 2, vacant: 1 });
    expect(addOccupancy([counts, { occupied: 1, not_lettable: 1 }])).toEqual({
      occupied: 3,
      vacant: 1,
      not_lettable: 1,
    });
  });

  it('refuses an unknown status or a bad count', () => {
    expect(() => occupancyOf({ let: 1 } as never)).toThrow(/Not a unit status/);
    expect(() => occupancyOf({ occupied: -1 })).toThrow(/zero or more/);
  });

  it('never shows more than 100% occupied, and its parts add up', () => {
    const count = fc.integer({ min: 0, max: 5_000 });
    fc.assert(
      fc.property(fc.tuple(count, count, count, count, count), (values) => {
        const counts = Object.fromEntries(DISPLAY_STATUSES.map((s, i) => [s, values[i]]));
        const o = occupancyOf(counts);
        expect(o.occupied + o.vacant + o.notLettable).toBe(o.units);
        expect(o.available + o.reserved + o.underRepair).toBe(o.vacant);
        if (o.rate.bps !== null) expect(o.rate.bps <= 10_000).toBe(true);
      }),
    );
  });
});

describe('DA-01 rent roll', () => {
  const lease = (
    overrides: Partial<RentRollLease> & Pick<RentRollLease, 'leaseId'>,
  ): RentRollLease => ({
    startDate: '2026-01-15',
    lastDay: null,
    monthlyRentMinor: 150_000,
    ...overrides,
  });

  it('is the monthly rent in force, plus service charge, of leases active on the day', () => {
    const roll = rentRoll(
      [
        lease({ leaseId: 'b', serviceChargeMonthlyMinor: 20_000 }),
        lease({
          leaseId: 'a',
          monthlyRentMinor: 1_000_000,
          steps: [
            { effectiveFrom: '2026-07-15', monthlyRentMinor: 1_050_000 },
            { effectiveFrom: '2027-01-15', monthlyRentMinor: 1_100_000 },
          ],
        }),
        // Ended before the day, or not started: left out.
        lease({ leaseId: 'ended', lastDay: '2026-10-31' }),
        lease({ leaseId: 'future', startDate: '2026-12-01' }),
        // Holding over after its end date, month to month: still on the roll (OQ-12).
        lease({ leaseId: 'holding', startDate: '2025-11-01', lastDay: null }),
      ],
      '2026-11-05',
    );
    expect(roll.leases).toEqual([
      { leaseId: 'a', rentMinor: 1_050_000, serviceChargeMinor: 0 },
      { leaseId: 'b', rentMinor: 150_000, serviceChargeMinor: 20_000 },
      { leaseId: 'holding', rentMinor: 150_000, serviceChargeMinor: 0 },
    ]);
    expect(roll.rentMinor).toBe(1_350_000);
    expect(roll.serviceChargeMinor).toBe(20_000);
    expect(roll.totalMinor).toBe(1_370_000);
  });

  it('counts a lease on its first and last day', () => {
    expect(leaseActiveOn({ startDate: '2026-11-05', lastDay: null }, '2026-11-05')).toBe(true);
    expect(leaseActiveOn({ startDate: '2026-01-01', lastDay: '2026-11-05' }, '2026-11-05')).toBe(
      true,
    );
    expect(leaseActiveOn({ startDate: '2026-01-01', lastDay: '2026-11-04' }, '2026-11-05')).toBe(
      false,
    );
  });

  it('is zero for no active lease, and refuses a date that is not one', () => {
    expect(rentRoll([], '2026-11-05').totalMinor).toBe(0);
    expect(() => rentRoll([], '2026-11-31')).toThrow(/Not a date/);
  });
});

describe('DA-01 paid-until coverage (prd-issues 32)', () => {
  it('counts occupied units paid until today or later, and the median months paid ahead', () => {
    const coverage = paidUntilCoverage({
      today: '2026-11-05',
      units: [
        { unitId: 'u1', paidUntil: '2026-11-14', monthsPaidAhead: 0 },
        { unitId: 'u2', paidUntil: '2026-11-05', monthsPaidAhead: 0 },
        { unitId: 'u3', paidUntil: '2028-10-31', monthsPaidAhead: 23 },
        { unitId: 'u4', paidUntil: '2027-10-31', monthsPaidAhead: 11 },
        { unitId: 'u5', paidUntil: '2026-09-30', monthsPaidAhead: 0 },
        { unitId: 'u6', paidUntil: null, monthsPaidAhead: 0 },
      ],
    });
    expect(coverage).toEqual({
      occupied: 6,
      covered: 4,
      rate: { numerator: 4, denominator: 6, bps: 6_667 },
      medianMonthsPaidAhead: 0,
    });
  });

  it('takes the lower middle for an even count', () => {
    const coverage = paidUntilCoverage({
      today: '2026-11-05',
      units: [
        { unitId: 'u1', paidUntil: '2027-04-30', monthsPaidAhead: 5 },
        { unitId: 'u2', paidUntil: '2027-10-31', monthsPaidAhead: 11 },
      ],
    });
    expect(coverage.medianMonthsPaidAhead).toBe(5);
  });

  it('is empty with no occupied unit, and refuses a unit twice', () => {
    expect(paidUntilCoverage({ today: '2026-11-05', units: [] })).toEqual({
      occupied: 0,
      covered: 0,
      rate: { numerator: 0, denominator: 0, bps: null },
      medianMonthsPaidAhead: null,
    });
    const unit = { unitId: 'u1', paidUntil: null, monthsPaidAhead: 0 };
    expect(() => paidUntilCoverage({ today: '2026-11-05', units: [unit, unit] })).toThrow(
      /listed twice/,
    );
  });
});
