import { describe, expect, it } from 'vitest';
import { earliestOwnerChange, formatBusinessDate, notBefore, todayIn } from './business-dates';
import {
  bedroomsRule,
  countsSummary,
  domainProblem,
  hasCode,
  locationLabel,
  shareLabel,
  statusValueLabel,
  totalOf,
  unitTypeLabel,
} from './register-format';

const counts = { occupied: 0, reserved: 1, under_repair: 2, not_lettable: 0, vacant: 9 };

describe('PR-02 unit types on screen', () => {
  it('asks the domain which unit types take bedrooms', () => {
    expect(bedroomsRule('apartment')).toBe('required');
    expect(bedroomsRule('detached_house')).toBe('optional');
    expect(bedroomsRule('townhouse')).toBe('optional');
    expect(bedroomsRule('single_room')).toBe('none');
    expect(bedroomsRule('shop')).toBe('none');
  });

  it('names a type with its bedrooms', () => {
    expect(unitTypeLabel('apartment', 1)).toBe('Apartment, 1 bedroom');
    expect(unitTypeLabel('apartment', 3)).toBe('Apartment, 3 bedrooms');
    expect(unitTypeLabel('chamber_and_hall', null)).toBe('Chamber and hall');
  });
});

describe('PR-06 status counts and history in words', () => {
  it('summarises counts in the usual order and leaves out zeros', () => {
    expect(countsSummary(counts)).toBe('1 reserved, 2 under repair, 9 vacant');
    expect(countsSummary({ ...counts, reserved: 0, under_repair: 0, vacant: 0 })).toBe('No units');
    expect(totalOf(counts)).toBe(12);
  });

  it('names availability and occupancy values', () => {
    expect(statusValueLabel('under_repair')).toBe('Under repair');
    expect(statusValueLabel('available')).toBe('Available');
    expect(statusValueLabel('occupied')).toBe('Occupied');
    expect(statusValueLabel(null)).toBe('None');
  });
});

describe('AD-02 ownership on screen', () => {
  it('shows shares in basis points as percentages', () => {
    expect(shareLabel(10_000)).toBe('100%');
    expect(shareLabel(2_500)).toBe('25%');
    expect(shareLabel(3_333)).toBe('33.33%');
  });

  it('starts an owner change today, or the day after the latest change', () => {
    expect(earliestOwnerChange(['2026-01-15'], '2026-10-29')).toBe('2026-10-29');
    expect(earliestOwnerChange(['2026-10-29'], '2026-10-29')).toBe('2026-10-30');
    expect(earliestOwnerChange(['2026-10-29', '2026-12-31'], '2026-10-29')).toBe('2027-01-01');
    expect(notBefore('2026-10-30', '2026-10-30')).toBe(true);
    expect(notBefore('2026-10-29', '2026-10-30')).toBe(false);
    expect(notBefore('29/10/2026', '2026-10-01')).toBe(false);
  });

  it('takes today in the company time zone, not the browser’s', () => {
    // 23:30 UTC on 31 December is still 31 December in Accra (GMT), but 1 January in Tokyo.
    const lateUtc = new Date('2026-12-31T23:30:00Z');
    expect(todayIn('Africa/Accra', lateUtc)).toBe('2026-12-31');
    expect(todayIn('Asia/Tokyo', lateUtc)).toBe('2027-01-01');
    expect(formatBusinessDate('2026-10-29')).toBe('29 Oct 2026');
    expect(formatBusinessDate('not a date')).toBe('not a date');
  });
});

describe('PR-03 locations on screen', () => {
  it('joins the parts of a location that are known', () => {
    expect(locationLabel({ town: 'Legon', district: null, region: 'Greater Accra' })).toBe(
      'Legon, Greater Accra',
    );
    expect(locationLabel({})).toBe('No location');
  });
});

describe('API refusals on screen', () => {
  it('reads domain check messages and compares API codes without case', () => {
    expect(
      domainProblem(() => {
        throw new Error('Enter the bedrooms');
      }),
    ).toBe('Enter the bedrooms');
    expect(domainProblem(() => 'fine')).toBeNull();
    expect(hasCode('PROPERTY_CODE_TAKEN', 'property_code_taken')).toBe(true);
    expect(hasCode(null, 'property_code_taken')).toBe(false);
  });
});
