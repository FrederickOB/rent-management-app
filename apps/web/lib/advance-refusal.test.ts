import { describe, expect, it } from 'vitest';
import { advanceRefusal } from './advance-refusal';

/** The refusal as the typed client throws it: oRPC's code, status, message and data. */
const refusal = (
  data: unknown,
  message = 'Your company’s setting refuses rent paid more than 6 months ahead for a lease of this length (Act 220 s.25(5), unverified: counsel to confirm). The most this payment may be is GH₵3,000.00.',
) => ({
  status: 422,
  code: 'ADVANCE_OVER_LIMIT',
  message,
  data,
});

describe('AR-05 under “block” the cash and transfer forms say the most that can be recorded, and why', () => {
  it('reads the most and the limit, sent as strings, and explains them', () => {
    const found = advanceRefusal(refusal({ maxMinor: '300000', limitMonths: '6' }));
    expect(found).toEqual({
      maxMinor: 300_000,
      limitMonths: 6,
      text: 'Your company’s advance rent setting refuses rent paid more than 6 months ahead for a lease of this length (Act 220 s.25(5); the limit is not yet verified by counsel). The most this payment can be is GH₵3,000.00. Nothing was recorded.',
    });
    expect(found?.text).not.toMatch(/compliant/i);
  });

  it('never calls a verified limit unverified, and says when nothing more fits', () => {
    const found = advanceRefusal(
      refusal(
        { maxMinor: '0', limitMonths: '1' },
        'Your company’s setting refuses rent paid more than 1 month ahead.',
      ),
    );
    expect(found?.text).toBe(
      'Your company’s advance rent setting refuses rent paid more than 1 month ahead for a lease of this length (Act 220 s.25(5)). Nothing more can be recorded ahead for it now. Nothing was recorded.',
    );
  });

  it('leaves every other answer alone', () => {
    expect(advanceRefusal({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED', data: {} })).toBeNull();
    expect(advanceRefusal(refusal({ maxMinor: 'lots', limitMonths: '6' }))).toBeNull();
    expect(advanceRefusal(new TypeError('offline'))).toBeNull();
  });
});
