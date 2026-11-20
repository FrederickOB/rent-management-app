import { RETENTION_CATEGORIES } from '@rent/domain/data-protection';
import { describe, expect, it } from 'vitest';
import { decide, RETENTION_RULE_KEYS, retainedUntil, type RetentionRule } from './retention';

const rule = (over: Partial<RetentionRule> = {}): RetentionRule => ({
  category: 'tenant_profile',
  ruleKey: RETENTION_RULE_KEYS.tenant_profile,
  ruleId: '019a3000-0000-7000-8000-000000000001',
  verified: false,
  years: null,
  ...over,
});

describe('NFR-DP erasure is limited by retention (M11 decision 5)', () => {
  it('names a rules row for every category', () => {
    expect(Object.keys(RETENTION_RULE_KEYS).sort()).toEqual([...RETENTION_CATEGORIES].sort());
    expect(RETENTION_RULE_KEYS.financial_and_notices).toBe('data_retention.financial_and_notices');
    expect(RETENTION_RULE_KEYS.identity).toBe('data_retention.other.identity_data');
  });

  it('holds records while the rule is unverified or has no value, with no date, saying why', () => {
    const none = decide(rule(), 3, '2020-01-01', '2026-11-10', false);
    expect(none).toMatchObject({ kind: 'held', records: 3, until: null });
    expect(none.kind === 'held' && none.reason).toContain('no value yet');
    const unverified = decide(rule({ years: 6 }), 3, '2010-01-01', '2026-11-10', false);
    expect(unverified).toMatchObject({ kind: 'held', until: null });
    expect(unverified.kind === 'held' && unverified.reason).toContain('not verified');
  });

  it('holds records while a lease runs, then until the period ends, and only then anonymises', () => {
    const verified = rule({ verified: true, years: 6 });
    expect(decide(verified, 2, null, '2026-11-10', true)).toMatchObject({
      kind: 'held',
      until: null,
    });
    expect(decide(verified, 2, '2021-11-11', '2026-11-10', false)).toEqual({
      kind: 'held',
      records: 2,
      until: '2027-11-11',
      reason: expect.stringContaining('6 years from 2021-11-11'),
    });
    // The last day held is the day before; on the day itself the period is over.
    expect(decide(verified, 2, '2020-11-10', '2026-11-10', false)).toEqual({
      kind: 'anonymise',
      records: 2,
    });
    expect(decide(verified, 0, '2000-01-01', '2026-11-10', false)).toEqual({ kind: 'none' });
  });

  it('counts whole years from the day the period starts, leap days included', () => {
    expect(retainedUntil('2020-02-29', 1)).toBe('2021-02-28');
    expect(retainedUntil('2026-11-10', 0)).toBe('2026-11-10');
    expect(retainedUntil('2026-01-31', 6)).toBe('2032-01-31');
  });
});
