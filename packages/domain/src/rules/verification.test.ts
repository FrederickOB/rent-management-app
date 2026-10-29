import { describe, expect, it } from 'vitest';
import { verificationWarning } from './resolve';

describe('TX-08 the warning staff see comes from the rule version used', () => {
  it('says unverified only when the rule is, and nothing when it is verified', () => {
    expect(verificationWarning('unverified')).toBe('unverified: counsel to confirm');
    expect(verificationWarning('from_prd')).toBe(
      'taken from the PRD and not yet verified: counsel to confirm',
    );
    expect(verificationWarning('verified')).toBeNull();
  });
});
