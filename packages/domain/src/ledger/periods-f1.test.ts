import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { accountingDateFor, isLockedDate, lastDayOfMonth, lockDateOf, monthOf } from './periods';

/** A business date `offset` days after 1 January 2026. */
const dayAt = (offset: number) =>
  new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
/** The month `m` months after January 2026, as `YYYY-MM`. */
const monthAt = (m: number) => new Date(Date.UTC(2026, m, 1)).toISOString().slice(0, 7);

describe('AC-04 F1 an issued statement locks its month and every month before it', () => {
  it('takes the lock date as the last day of the latest month a statement locked', () => {
    expect(lockDateOf([])).toBeNull();
    expect(lockDateOf(['2026-10'])).toBe('2026-10-31');
    expect(lockDateOf(['2026-01-01', '2026-02', '2025-12'])).toBe('2026-02-28');
    expect(lockDateOf(['2028-02'])).toBe('2028-02-29');
    expect(lastDayOfMonth('2026-11-14')).toBe('2026-11-30');
  });

  it('reports a late entry dated in an earlier, unissued month on the first open day', () => {
    // October is issued; September never was. September's money lands in November.
    const lock = lockDateOf(['2026-10']);
    expect(accountingDateFor('2026-09-12', new Set(), lock)).toBe('2026-11-01');
    expect(accountingDateFor('2026-10-31', new Set(), lock)).toBe('2026-11-01');
    expect(accountingDateFor('2026-11-01', new Set(), lock)).toBe('2026-11-01');
    expect(accountingDateFor('2026-11-14', new Set(), lock)).toBe('2026-11-14');
    // A month locked by hand after the lock date still moves it on (M4a).
    expect(accountingDateFor('2026-09-12', new Set(['2026-11']), lock)).toBe('2026-12-01');
  });

  it('never reports on or before the lock date nor in a month locked by hand, and moves only what it must (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1500 }),
        fc.option(fc.integer({ min: 0, max: 48 }), { nil: null }),
        fc.uniqueArray(fc.integer({ min: 0, max: 60 }), { maxLength: 12 }),
        (offset, statementMonth, manual) => {
          const value = dayAt(offset);
          const lock = statementMonth === null ? null : lockDateOf([monthAt(statementMonth)]);
          const months = new Set(manual.map(monthAt));
          const date = accountingDateFor(value, months, lock);
          expect(date >= value).toBe(true);
          expect(isLockedDate(date, months, lock)).toBe(false);
          if (lock !== null) expect(date > lock).toBe(true);
          // An open value date keeps its day; a moved one lands on the 1st (the first open day).
          if (!isLockedDate(value, months, lock)) expect(date).toBe(value);
          else expect(date.endsWith('-01')).toBe(true);
          // Every month between the value date and the result is locked one way or another.
          for (let m = monthOf(value); m < monthOf(date); m = monthOf(lastDayOfNext(m)))
            expect(lock !== null && `${m}-01` <= lock ? true : months.has(m)).toBe(true);
        },
      ),
    );
  });

  it('with no lock date, keeps M4a’s rule: each month locked by hand stands alone', () => {
    expect(accountingDateFor('2026-09-12', new Set(['2026-10']))).toBe('2026-09-12');
    expect(accountingDateFor('2026-10-03', new Set(['2026-10']))).toBe('2026-11-01');
  });
});

/** The last day of the month after `month` (to step a loop one month on). */
function lastDayOfNext(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return lastDayOfMonth(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10));
}
