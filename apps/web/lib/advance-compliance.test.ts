import { describe, expect, it } from 'vitest';
import {
  aheadLabel,
  leaseAdvanceLabel,
  overBy,
  paymentAdvanceLabel,
  policyNote,
  reportWords,
  ruleLabel,
  type AdvanceRow,
} from './advance-compliance';

const row: AdvanceRow = {
  monthsAhead: 23,
  limitMonths: 6,
  receivedOn: '2026-10-01',
  rule: {
    key: 'advance_rent.max_months.over_six_months',
    verificationStatus: 'unverified',
    effectiveFrom: '2026-01-01',
  },
};

describe('AR-05 the advance rent report says how far ahead, the limit and its rule', () => {
  it('says the months paid ahead, the limit and how far over', () => {
    expect(aheadLabel(row)).toBe(
      '23 months paid ahead; the limit for this lease’s term is 6 months',
    );
    expect(overBy(row)).toBe('17 months over the limit');
    expect(overBy({ monthsAhead: 1, limitMonths: 1 })).toBeNull();
    expect(aheadLabel({ monthsAhead: 1, limitMonths: 1 })).toBe(
      '1 month paid ahead; the limit for this lease’s term is 1 month',
    );
  });

  it('names the rule version and says counsel has not verified it', () => {
    expect(ruleLabel(row.rule)).toBe(
      'advance_rent.max_months.over_six_months, in force from 1 Jan 2026. Unverified: counsel to confirm',
    );
    expect(ruleLabel(null)).toBe('No rule recorded');
  });

  it('records without flagging under “off”, and says so', () => {
    expect(policyNote('off')).toContain('nothing is flagged');
    expect(policyNote('block')).toContain('recorded and listed here for a person');
  });

  it('never calls an advance compliant, under any policy', () => {
    for (const policy of ['off', 'warn', 'block'] as const)
      for (const words of reportWords(policy, [row, { ...row, rule: null }]))
        expect(words).not.toMatch(/compliant|compliance with/i);
  });
});

describe('AR-05 months paid ahead are recorded on every payment, and flagged only under warn or block', () => {
  it('says the months ahead under “off”, with no flag (D6)', () => {
    expect(
      paymentAdvanceLabel({
        monthsAhead: 23,
        policy: 'off',
        limitMonths: 6,
        overLimit: true,
        flagged: false,
      }),
    ).toEqual({ text: 'After this payment the lease is paid 23 months ahead.', flag: null });
    expect(
      paymentAdvanceLabel({
        monthsAhead: 0,
        policy: 'warn',
        limitMonths: 6,
        overLimit: false,
        flagged: false,
      }).text,
    ).toBe('After this payment the lease is not paid for any month ahead.');
  });

  it('flags a payment over the limit, never calling it compliant or not', () => {
    const flagged = paymentAdvanceLabel({
      monthsAhead: 12,
      policy: 'warn',
      limitMonths: 6,
      overLimit: true,
      flagged: true,
    });
    expect(flagged.flag).toBe(
      'Over the advance rent limit: 12 months paid ahead; the limit for this lease’s term is 6 months. Your company flags it; a person should look at it.',
    );
    expect(`${flagged.text} ${flagged.flag}`).not.toMatch(/compliant/i);
    expect(
      paymentAdvanceLabel({
        monthsAhead: 12,
        policy: 'block',
        limitMonths: 6,
        overLimit: true,
        flagged: true,
      }).flag,
    ).toContain('it arrived from a payment provider, so it was recorded');
  });
});

describe('AR-05 the lease page says how far ahead the lease is paid, and flags only under warn or block', () => {
  const advance = {
    policy: 'warn' as const,
    monthsAheadNow: 22,
    limitMonths: 6,
    rule: {
      key: 'advance_rent.max_months.over_six_months',
      verificationStatus: 'unverified' as const,
    },
    overLimitNow: true,
    flaggedPayments: [
      {
        paymentId: 'p1',
        valueDate: '2026-10-01',
        monthsAhead: 23,
        limitMonths: 6,
        policy: 'warn' as const,
      },
    ],
  };

  it('flags the latest payment over the limit under “warn”', () => {
    expect(leaseAdvanceLabel(advance)).toEqual({
      text: 'The lease is paid 22 months ahead.',
      flag: 'A payment on 1 Oct 2026 paid 23 months ahead; the limit for this lease’s term is 6 months. Your company flags it; a person should look at it. The limit is not yet verified by counsel.',
    });
    expect(
      leaseAdvanceLabel({
        ...advance,
        rule: { ...advance.rule, verificationStatus: 'verified' as const },
      }).flag,
    ).not.toContain('not yet verified');
  });

  it('records the months ahead under “off” without a flag (D6)', () => {
    expect(leaseAdvanceLabel({ ...advance, policy: 'off' })).toEqual({
      text: 'The lease is paid 22 months ahead.',
      flag: null,
    });
    expect(leaseAdvanceLabel({ ...advance, monthsAheadNow: 0, flaggedPayments: [] }).text).toBe(
      'The lease is not paid for any month ahead.',
    );
  });
});
