import { describe, expect, it } from 'vitest';
import { paymentAdvanceLabel, paymentAheadCell } from './advance-compliance';

describe('AR-05 every payment’s months paid ahead are shown, flagged only under warn or block', () => {
  it('says how far ahead each payment paid in the lease’s payments table', () => {
    expect(paymentAheadCell({ monthsAhead: 0, flagged: false })).toEqual({
      text: 'None ahead',
      flagged: false,
    });
    expect(paymentAheadCell({ monthsAhead: 1, flagged: false }).text).toBe('1 month ahead');
    expect(paymentAheadCell({ monthsAhead: 11, flagged: true })).toEqual({
      text: '11 months ahead',
      flagged: true,
    });
  });

  it('says it on the payment page with the limit’s rule, flagging only what the API flagged', () => {
    const recorded = {
      monthsAhead: 11,
      policy: 'warn' as const,
      limitMonths: 6,
      overLimit: true,
      flagged: true,
    };
    const rule = {
      key: 'advance_rent.max_months.over_six_months',
      verificationStatus: 'unverified' as const,
    };
    expect(paymentAdvanceLabel(recorded, rule)).toEqual({
      text: 'After this payment the lease is paid 11 months ahead.',
      flag: 'Over the advance rent limit: 11 months paid ahead; the limit for this lease’s term is 6 months. Your company flags it; a person should look at it. The limit is not yet verified by counsel.',
    });
    // Over the limit under `off`: recorded, never flagged (D6).
    expect(
      paymentAdvanceLabel({ ...recorded, policy: 'off', flagged: false }, rule).flag,
    ).toBeNull();
  });
});
