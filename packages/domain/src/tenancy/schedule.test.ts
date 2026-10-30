import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, addMonths, daysBetween, parseBusinessDate, toIsoDate } from '../dates';
import { checkLeaseTerms, type LeaseTermsInput } from './lease-terms';
import { holdingOverPeriods, rentSchedule } from './schedule';

const base: LeaseTermsInput = {
  startDate: '2026-11-01',
  endDate: '2028-10-31',
  monthlyRentMinor: 150_000,
  cycle: 'monthly',
  noticeDays: 30,
  use: 'residential',
};

const rents = (rows: ReturnType<typeof rentSchedule>) =>
  rows.filter((r) => r.chargeType === 'rent');

describe('TL-06 rent schedule', () => {
  it('gives a two-year lease 24 whole monthly periods (worked example A)', () => {
    const rows = rents(rentSchedule(checkLeaseTerms(base)));
    expect(rows).toHaveLength(24);
    expect(rows[0]).toMatchObject({
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      amountMinor: 150_000,
    });
    expect(rows.at(-1)).toMatchObject({
      periodStart: '2028-10-01',
      periodEnd: '2028-10-31',
      prorated: false,
    });
  });

  it('anchors every period on the start day, so 31 January never drifts', () => {
    const rows = rents(
      rentSchedule(checkLeaseTerms({ ...base, startDate: '2027-01-31', endDate: '2027-06-29' })),
    );
    expect(rows.map((r) => r.periodStart)).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
    ]);
    expect(rows.map((r) => r.periodEnd)).toEqual([
      '2027-02-27',
      '2027-03-30',
      '2027-04-29',
      '2027-05-30',
      '2027-06-29',
    ]);
  });

  it('prorates only a short final period, by days, rounded half up once', () => {
    // 1 Nov 2026 to 15 Nov 2027: 12 whole months, then 15 of the 30 days from 1 to 30 November.
    const rows = rents(
      rentSchedule(checkLeaseTerms({ ...base, endDate: '2027-11-15', monthlyRentMinor: 100_001 })),
    );
    expect(rows).toHaveLength(13);
    expect(rows.slice(0, 12).every((r) => !r.prorated && r.amountMinor === 100_001)).toBe(true);
    expect(rows[12]).toMatchObject({
      periodStart: '2027-11-01',
      periodEnd: '2027-11-15',
      prorated: true,
      amountMinor: 50_001,
    });
  });

  it('applies escalation steps from their period, and lists service charge separately', () => {
    const terms = checkLeaseTerms({
      ...base,
      serviceChargeMonthlyMinor: 20_000,
      steps: [{ effectiveFrom: '2027-11-01', monthlyRentMinor: 165_000 }],
    });
    const rows = rentSchedule(terms);
    expect(rows.filter((r) => r.chargeType === 'service_charge')).toHaveLength(24);
    const rent = rents(rows);
    expect(rent[11]!.amountMinor).toBe(150_000);
    expect(rent[12]!.amountMinor).toBe(165_000);
    expect(holdingOverPeriods(terms, 24)).toEqual([
      {
        sequence: 24,
        chargeType: 'rent',
        periodStart: '2028-11-01',
        periodEnd: '2028-11-30',
        amountMinor: 165_000,
        prorated: false,
      },
      {
        sequence: 24,
        chargeType: 'service_charge',
        periodStart: '2028-11-01',
        periodEnd: '2028-11-30',
        amountMinor: 20_000,
        prorated: false,
      },
    ]);
  });

  it('covers every term exactly with contiguous, anchored periods (property-based)', () => {
    const day = (offset: number) => toIsoDate(addDays(parseBusinessDate('2020-01-01'), offset));
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4000 }),
        fc.integer({ min: 1, max: 1500 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (startOffset, length, rent) => {
          const startDate = day(startOffset);
          const endDate = day(startOffset + length);
          const terms = checkLeaseTerms({ ...base, startDate, endDate, monthlyRentMinor: rent });
          const rows = rents(rentSchedule(terms));
          expect(rows[0]!.periodStart).toBe(startDate);
          expect(rows.at(-1)!.periodEnd).toBe(endDate);
          rows.forEach((row, k) => {
            expect(row.periodStart).toBe(toIsoDate(addMonths(parseBusinessDate(startDate), k)));
            if (k > 0)
              expect(toIsoDate(addDays(parseBusinessDate(rows[k - 1]!.periodEnd), 1))).toBe(
                row.periodStart,
              );
            if (k < rows.length - 1)
              expect(row).toMatchObject({ prorated: false, amountMinor: rent });
          });
          const last = rows.at(-1)!;
          const fullEnd = addDays(addMonths(parseBusinessDate(startDate), rows.length), -1);
          if (last.prorated) {
            const used =
              daysBetween(parseBusinessDate(last.periodStart), parseBusinessDate(last.periodEnd)) +
              1;
            const full = daysBetween(parseBusinessDate(last.periodStart), fullEnd) + 1;
            expect(used).toBeLessThan(full);
            // Half up on whole pesewas: |2 * amount * full - 2 * rent * used| <= full.
            const twice =
              2n * BigInt(last.amountMinor) * BigInt(full) - 2n * BigInt(rent) * BigInt(used);
            expect(twice <= BigInt(full) && twice > -BigInt(full)).toBe(true);
            expect(last.amountMinor).toBeLessThanOrEqual(rent);
          } else expect(last.periodEnd).toBe(toIsoDate(fullEnd));
        },
      ),
    );
  });
});
