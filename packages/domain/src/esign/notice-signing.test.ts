import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_CONSENT,
  CURRENT_NOTICE_CONSENT,
  NOTICE_SIGNING_STATEMENT,
  SIGNING_CONSENT,
  signingComplete,
  signingCompleteBy,
  type SignerStatus,
} from './signing';

const signer = fc.record({
  required: fc.boolean(),
  status: fc.constantFrom<SignerStatus>('pending', 'signed', 'declined'),
});

describe('LN-07 one signature', () => {
  it('completes an any_one request on the first required signature', () => {
    expect(
      signingCompleteBy('any_one', [
        { required: true, status: 'pending' },
        { required: true, status: 'signed' },
      ]),
    ).toBe(true);
    expect(signingCompleteBy('any_one', [{ required: true, status: 'pending' }])).toBe(false);
    expect(signingCompleteBy('any_one', [{ required: false, status: 'signed' }])).toBe(false);
    expect(signingCompleteBy('any_one', [])).toBe(false);
    expect(
      signingCompleteBy('any_one', [
        { required: true, status: 'declined' },
        { required: true, status: 'signed' },
      ]),
    ).toBe(true);
  });

  it('leaves all_required exactly as M3 built it (property-based)', () => {
    fc.assert(
      fc.property(fc.array(signer, { maxLength: 8 }), (signers) => {
        expect(signingCompleteBy('all_required', signers)).toBe(signingComplete(signers));
      }),
    );
  });

  it('completes any_one exactly when a required signer has signed, and never un-completes (property-based)', () => {
    fc.assert(
      fc.property(fc.array(signer, { maxLength: 8 }), fc.nat(), (signers, pick) => {
        const complete = signingCompleteBy('any_one', signers);
        expect(complete).toBe(signers.some((s) => s.required && s.status === 'signed'));
        if (signingComplete(signers)) expect(complete).toBe(true);
        if (signers.length > 0) {
          const i = pick % signers.length;
          const more = signers.map((s, j) => (j === i ? { ...s, status: 'signed' as const } : s));
          if (complete) expect(signingCompleteBy('any_one', more)).toBe(true);
        }
      }),
    );
  });
});

describe('LN-04 notice acknowledgement consent (plan 4.5)', () => {
  it('says signing acknowledges receipt, not agreement, and what is recorded', () => {
    const text = SIGNING_CONSENT[CURRENT_NOTICE_CONSENT]!;
    expect(CURRENT_NOTICE_CONSENT).toBe('notice_ack.v1');
    expect(text).toMatch(/acknowledge that I received it/);
    expect(text).toMatch(/does not mean that I agree/);
    expect(text).toMatch(/signature, the time, the phone number or email that received my code/);
    expect(text).not.toMatch(/legally|binding|valid service|served/i);
    expect(NOTICE_SIGNING_STATEMENT).toMatch(/acknowledges that you received this notice/);
    expect(NOTICE_SIGNING_STATEMENT).toMatch(/does not mean that you agree/);
  });

  it('keeps the lease consent as it was', () => {
    expect(CURRENT_CONSENT).toBe('consent.v1');
    expect(SIGNING_CONSENT[CURRENT_CONSENT]).toMatch(/agree to sign it electronically/);
  });
});
