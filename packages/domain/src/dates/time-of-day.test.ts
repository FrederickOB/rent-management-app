import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  businessDateOf,
  compareInstants,
  instantAtMinutes,
  instantFrom,
  minutesIntoDay,
  parseBusinessDate,
  parseTimeOfDay,
} from './dates';

describe('LN-05 sending window: times of day in company time (decision 11)', () => {
  it('parses HH:MM times', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('07:00')).toBe(420);
    expect(parseTimeOfDay('23:59')).toBe(1439);
    for (const bad of ['24:00', '7:00', '07:60', '0700', ''])
      expect(() => parseTimeOfDay(bad)).toThrow(expect.objectContaining({ code: 'time.invalid' }));
  });

  it('reads the local time of an instant', () => {
    const instant = instantFrom('2026-07-01T06:30:00Z');
    expect(minutesIntoDay(instant, 'Africa/Accra')).toBe(390);
    expect(minutesIntoDay(instant, 'Europe/London')).toBe(450);
  });

  it('builds an instant at a local time, moving forward over a clock change', () => {
    expect(instantAtMinutes(parseBusinessDate('2026-11-04'), 420, 'Africa/Accra').toString()).toBe(
      '2026-11-04T07:00:00Z',
    );
    // 01:30 does not exist in London on 29 March 2026.
    expect(instantAtMinutes(parseBusinessDate('2026-03-29'), 90, 'Europe/London').toString()).toBe(
      '2026-03-29T01:30:00Z',
    );
    expect(() => instantAtMinutes(parseBusinessDate('2026-11-04'), 1440)).toThrow(
      expect.objectContaining({ code: 'time.invalid' }),
    );
  });

  it('round-trips a local time on its own date (property-based)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 0, max: 1439 }),
        fc.constantFrom('Africa/Accra', 'Africa/Lagos', 'Europe/London'),
        (offset, minutes, timeZone) => {
          const date = addDays(parseBusinessDate('2026-01-01'), offset);
          const instant = instantAtMinutes(date, minutes, timeZone);
          expect(businessDateOf(instant, timeZone).equals(date)).toBe(true);
          if (timeZone !== 'Europe/London') expect(minutesIntoDay(instant, timeZone)).toBe(minutes);
          expect(compareInstants(instant, instant)).toBe(0);
        },
      ),
    );
  });
});
