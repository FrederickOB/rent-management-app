import { describe, expect, it } from 'vitest';
import { parseBusinessDate } from '../dates';
import { isKnownRuleKey, parseRuleValue } from './registry';
import { needsWarning, resolveAsOf, type RuleRow } from './resolve';

const row = (over: Partial<RuleRow> & Pick<RuleRow, 'id' | 'effectiveFrom'>): RuleRow => ({
  country: 'GH',
  key: 'rent_tax.rate.residential',
  value: { bps: 800 },
  effectiveTo: null,
  source: 'TX-01',
  verificationStatus: 'from_prd',
  createdAt: new Date('2026-10-28T00:00:00Z'),
  ...over,
});

describe('TX-08 rules engine (resolution)', () => {
  const original = row({ id: 'r1', effectiveFrom: parseBusinessDate('2000-01-01') });
  const future = row({
    id: 'r2',
    effectiveFrom: parseBusinessDate('2027-01-01'),
    value: { bps: 1000 },
  });

  it('returns the row in force on the business date', () => {
    expect(resolveAsOf([original, future], parseBusinessDate('2026-12-31'))?.id).toBe('r1');
    expect(resolveAsOf([original, future], parseBusinessDate('2027-01-01'))?.id).toBe('r2');
    expect(resolveAsOf([original], parseBusinessDate('1999-12-31'))).toBeUndefined();
  });

  it('leaves past dates unchanged when a future-dated row is added', () => {
    const before = resolveAsOf([original], parseBusinessDate('2026-06-01'));
    const after = resolveAsOf([original, future], parseBusinessDate('2026-06-01'));
    expect(after).toBe(before);
  });

  it('prefers the newest row for the same date (a verification of the same value)', () => {
    const verified = row({
      id: 'r3',
      effectiveFrom: parseBusinessDate('2000-01-01'),
      verificationStatus: 'verified',
      createdAt: new Date('2027-03-01T00:00:00Z'),
    });
    const resolved = resolveAsOf([original, verified], parseBusinessDate('2027-06-01'));
    expect(resolved?.id).toBe('r3');
    expect(needsWarning(original)).toBe(true);
    expect(needsWarning(verified)).toBe(false);
  });

  it('honours an effective-to date set at insert', () => {
    const ending = row({
      id: 'r4',
      effectiveFrom: parseBusinessDate('2026-01-01'),
      effectiveTo: parseBusinessDate('2026-06-30'),
    });
    expect(resolveAsOf([ending], parseBusinessDate('2026-06-30'))?.id).toBe('r4');
    expect(resolveAsOf([ending], parseBusinessDate('2026-07-01'))).toBeUndefined();
  });
});

describe('TX-08 rules engine (value schemas)', () => {
  it('validates values by key', () => {
    expect(parseRuleValue('rent_tax.rate.commercial', { bps: 1500 })).toEqual({ bps: 1500 });
    expect(() => parseRuleValue('rent_tax.rate.commercial', { bps: 15.5 })).toThrow();
    expect(() => parseRuleValue('rent_tax.rate.commercial', null)).toThrow();
    expect(parseRuleValue('notice_to_quit.statutory_min_days.residential', null)).toBeNull();
    expect(
      parseRuleValue('vat.commercial_rent', { vatBps: 1500, nhilBps: 250, getfundBps: 250 }),
    ).toBeTruthy();
  });

  it('rejects keys with no registered schema', () => {
    expect(isKnownRuleKey('made_up.key')).toBe(false);
    expect(() => parseRuleValue('made_up.key', 1)).toThrow();
  });
});
