import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, compareDates, daysBetween, parseBusinessDate, toIsoDate } from '../dates';
import { money, multiplyRatio } from '../money/money';
import { checkLeaseTerms, fullPeriodEnd, periodStart, type LeaseTermsInput } from './lease-terms';
import { holdingOverSchedule, renewalStartDate, scheduledTransition } from './lifecycle';
import { rentSchedule, type ChargePeriod } from './schedule';

/**
 * Holding over and the next lease on the unit (review finding 3; M3 plan 4.6 and 4.10): no two
 * leases charge a unit for the same day. A lease held over charges month by month until it ends;
 * the next lease's start caps it, and a period cut short is prorated by days.
 */
const base: LeaseTermsInput = {
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  monthlyRentMinor: 150_000,
  cycle: 'monthly',
  noticeDays: 30,
  use: 'residential',
};

const day = (from: string, n: number) => toIsoDate(addDays(parseBusinessDate(from), n));
const lastEnd = (rows: readonly ChargePeriod[]) =>
  rows.reduce<string | null>((m, r) => (m === null || r.periodEnd > m ? r.periodEnd : m), null);

describe('TL-06 holding over stops where the next lease starts', () => {
  it('stops at the day before the successor starts, prorating the period cut short', () => {
    const terms = checkLeaseTerms({ ...base, monthlyRentMinor: 100_001 });
    // Held over from 1 January 2027; the next lease starts on 16 March 2027 and has started.
    const rows = holdingOverSchedule(terms, '2027-04-10', { start: '2027-03-16', started: true });
    expect(rows.map((r) => [r.sequence, r.periodStart, r.periodEnd, r.prorated])).toEqual([
      [12, '2027-01-01', '2027-01-31', false],
      [13, '2027-02-01', '2027-02-28', false],
      [14, '2027-03-01', '2027-03-15', true],
    ]);
    // 15 of March's 31 days, rounded half up once.
    expect(rows[2]!.amountMinor).toBe(multiplyRatio(money(100_001), 15, 31).amountMinor);
  });

  it('waits to charge a period the successor cuts short until the successor has started', () => {
    const terms = checkLeaseTerms(base);
    const waiting = holdingOverSchedule(terms, '2027-03-20', {
      start: '2027-03-16',
      started: false,
    });
    expect(waiting.map((r) => r.periodStart)).toEqual(['2027-01-01', '2027-02-01']);
    // Nothing is charged once the successor starts the day after the end.
    expect(
      holdingOverSchedule(terms, '2027-05-01', { start: '2027-01-01', started: true }),
    ).toEqual([]);
    // With no successor it is unchanged.
    expect(holdingOverSchedule(terms, '2027-03-20', null)).toEqual(
      holdingOverSchedule(terms, '2027-03-20'),
    );
  });

  it('cuts the rest of a short final month so its two parts make the prorated month exactly', () => {
    // The last period runs 1 to 15 March 2027; the successor starts on 21 March.
    const terms = checkLeaseTerms({
      ...base,
      startDate: '2026-04-01',
      endDate: '2027-03-15',
      monthlyRentMinor: 100_001,
    });
    const last = rentSchedule(terms).at(-1)!;
    const rows = holdingOverSchedule(terms, '2027-03-25', { start: '2027-03-21', started: true });
    expect(rows.map((r) => [r.sequence, r.periodStart, r.periodEnd])).toEqual([
      [12, '2027-03-16', '2027-03-20'],
    ]);
    expect(last.amountMinor + rows[0]!.amountMinor).toBe(
      multiplyRatio(money(100_001), 20, 31).amountMinor,
    );
  });

  it('never charges a day on or after the successor’s start, and stays exact and stable (property-based)', () => {
    const anchor = '2020-01-01';
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 30, max: 900 }),
        // Whole cedis or more a month, so no prorated part rounds to nothing.
        fc.integer({ min: 1_000, max: 500_000_000 }),
        fc.option(fc.integer({ min: 1_000, max: 5_000_000 }), { nil: null }),
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 200 }),
        (startOffset, length, rent, service, successorAfter, todayAfter, laterDays) => {
          const startDate = day(anchor, startOffset);
          const endDate = day(startDate, length);
          const terms = checkLeaseTerms({
            ...base,
            startDate,
            endDate,
            monthlyRentMinor: rent,
            serviceChargeMonthlyMinor: service,
          });
          const successor = day(endDate, successorAfter);
          const today = day(endDate, todayAfter);
          const started = compareDates(parseBusinessDate(successor), parseBusinessDate(today)) <= 0;
          const rows = holdingOverSchedule(terms, today, { start: successor, started });
          const schedule = rentSchedule(terms);
          const anchorDate = parseBusinessDate(startDate);
          for (const type of ['rent', 'service_charge'] as const) {
            const all = [...schedule, ...rows].filter((r) => r.chargeType === type);
            // Contiguous: each period starts the day after the one before, with no overlap.
            for (let i = 1; i < all.length; i += 1)
              expect(all[i]!.periodStart).toBe(day(all[i - 1]!.periodEnd, 1));
          }
          const monthly = (r: ChargePeriod) =>
            r.chargeType === 'rent' ? terms.monthlyRentMinor : terms.serviceChargeMonthlyMinor!;
          for (const r of rows) {
            // Nothing on or after the successor's first day, and nothing for nothing.
            expect(r.periodEnd < successor).toBe(true);
            expect(r.amountMinor).toBeGreaterThan(0);
            expect(r.sequence).toBeGreaterThanOrEqual(terms.periodCount);
            // The rent period (anchored on the lease start) the row falls in.
            let index = 0;
            while (
              compareDates(fullPeriodEnd(anchorDate, index), parseBusinessDate(r.periodStart)) < 0
            )
              index += 1;
            const from = periodStart(anchorDate, index);
            const full = fullPeriodEnd(anchorDate, index);
            const length = daysBetween(from, full) + 1;
            const upTo = daysBetween(from, parseBusinessDate(r.periodEnd)) + 1;
            // While the successor waits, only whole periods are charged.
            if (!started) expect(r.periodEnd).toBe(toIsoDate(full));
            // A period cut short is prorated by days, rounded half up once; with the part the
            // schedule already charged, it makes exactly the prorated month.
            const before = schedule
              .filter((p) => p.chargeType === r.chargeType && p.sequence === index)
              .reduce((sum, p) => sum + p.amountMinor, 0);
            expect(before + r.amountMinor).toBe(
              multiplyRatio(money(monthly(r)), upTo, length).amountMinor,
            );
          }
          // Coverage: once the successor has started, every day up to the day before it.
          const covered = lastEnd([...schedule, ...rows])!;
          const dayBefore = day(successor, -1);
          if (started) expect(covered).toBe(dayBefore > endDate ? dayBefore : endDate);
          else expect(covered <= dayBefore || covered === endDate).toBe(true);
          // Stable: a later run (and the successor starting) only adds rows, never changes one.
          const later = day(today, laterDays);
          const again = holdingOverSchedule(terms, later, {
            start: successor,
            started:
              started || compareDates(parseBusinessDate(successor), parseBusinessDate(later)) <= 0,
          });
          for (const r of rows) expect(again).toContainEqual(r);
        },
      ),
    );
  });
});

describe('TL-09 a renewal of a held-over lease starts after the last day charged', () => {
  const terms = checkLeaseTerms({ ...base, startDate: '2026-01-31', endDate: '2027-01-30' });

  it('starts at the first rent period after the last day already charged', () => {
    // Held over; the period from 28 February to 30 March is already charged.
    expect(renewalStartDate(terms, '2027-02-28', '2027-03-30')).toBe('2027-03-31');
    // Charged through today's period, run on the first day of it: the next one, never today.
    expect(renewalStartDate(terms, '2027-03-31', '2027-04-29')).toBe('2027-04-30');
    // Not yet held over: the day after the end.
    expect(renewalStartDate(terms, '2026-12-01', '2027-01-30')).toBe('2027-01-31');
  });

  it('never starts on or before a day already charged, or before today (property-based)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 400 }), (a, b) => {
        const charged = toIsoDate(fullPeriodEnd(parseBusinessDate(terms.startDate), 12 + (a % 14)));
        const today = day(terms.endDate, b);
        const start = renewalStartDate(terms, today, charged);
        expect(start > charged).toBe(true);
        expect(start >= today || start === day(terms.endDate, 1)).toBe(true);
        // On a rent period boundary, so the renewal continues the months exactly.
        const anchor = parseBusinessDate(terms.startDate);
        let k = 0;
        while (toIsoDate(periodStart(anchor, k)) < start) k += 1;
        expect(toIsoDate(periodStart(anchor, k)) === start || start === day(terms.endDate, 1)).toBe(
          true,
        );
      }),
    );
  });
});

describe('TL-09 a lease ends when the next lease on its unit starts', () => {
  const lease = { startDate: '2026-11-01', endDate: '2027-10-31', renewalStart: null };

  it('ends a held-over or ending lease the day before its successor starts', () => {
    const next = { ...lease, successorStart: '2028-01-16' };
    expect(scheduledTransition({ ...next, status: 'holding_over' }, '2028-01-15')).toBeNull();
    expect(scheduledTransition({ ...next, status: 'holding_over' }, '2028-01-16')).toEqual({
      to: 'ended',
      endReason: 'superseded',
      endedOn: '2028-01-15',
    });
    expect(scheduledTransition({ ...next, status: 'ending' }, '2028-02-01')).toEqual({
      to: 'ended',
      endReason: 'superseded',
      endedOn: '2028-01-15',
    });
  });

  it('holds an active lease over first when its successor leaves a gap after the end', () => {
    const gap = { ...lease, successorStart: '2027-12-01' };
    expect(scheduledTransition({ ...gap, status: 'active' }, '2027-12-05')).toEqual({
      to: 'holding_over',
      holdingOverSince: '2027-11-01',
    });
    // No gap: it ends on its end date.
    const next = { ...lease, successorStart: '2027-11-01' };
    expect(scheduledTransition({ ...next, status: 'active' }, '2027-11-01')).toEqual({
      to: 'ended',
      endReason: 'superseded',
      endedOn: '2027-10-31',
    });
    // A renewal that leaves a gap holds over too, then ends the day before it.
    const late = { ...lease, renewalStart: '2028-01-01' };
    expect(scheduledTransition({ ...late, status: 'active' }, '2028-01-02')).toEqual({
      to: 'holding_over',
      holdingOverSince: '2027-11-01',
    });
  });
});
