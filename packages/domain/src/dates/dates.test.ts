import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  businessDateOf,
  daysBetween,
  formatInstant,
  instantFrom,
  parseBusinessDate,
  startOfDay,
  toIsoDate,
} from './dates';

describe('NFR-LOC dates', () => {
  it('parses only real calendar dates', () => {
    expect(toIsoDate(parseBusinessDate('2028-02-29'))).toBe('2028-02-29');
    expect(() => parseBusinessDate('2027-02-29')).toThrow();
    expect(() => parseBusinessDate('28/10/2026')).toThrow();
  });

  it('clamps month arithmetic to the end of shorter months', () => {
    expect(toIsoDate(addMonths(parseBusinessDate('2026-01-31'), 1))).toBe('2026-02-28');
    expect(toIsoDate(addMonths(parseBusinessDate('2028-01-31'), 1))).toBe('2028-02-29');
    expect(toIsoDate(addMonths(parseBusinessDate('2026-03-15'), 12))).toBe('2027-03-15');
  });

  it('adds and counts days consistently', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5_000, max: 5_000 }), (n) => {
        const start = parseBusinessDate('2026-10-28');
        expect(daysBetween(start, addDays(start, n))).toBe(n);
      }),
    );
  });

  it('maps instants to business dates in the company time zone', () => {
    const lateEvening = instantFrom('2026-10-28T23:30:00Z');
    expect(toIsoDate(businessDateOf(lateEvening, 'Africa/Accra'))).toBe('2026-10-28');
    // London is on GMT at the end of October 2026, so the same instant is still the 28th;
    // in June it is BST, so 23:30Z is already the next day.
    expect(toIsoDate(businessDateOf(instantFrom('2026-06-10T23:30:00Z'), 'Europe/London'))).toBe(
      '2026-06-11',
    );
    expect(startOfDay(parseBusinessDate('2026-06-11'), 'Europe/London').toString()).toBe(
      '2026-06-10T23:00:00Z',
    );
  });

  it('always shows the time zone when formatting a time (DO-04)', () => {
    const text = formatInstant(instantFrom('2026-10-28T14:05:00Z'), 'Africa/Accra');
    expect(text).toContain('14:05');
    expect(text).toContain('(Africa/Accra)');
  });
});
