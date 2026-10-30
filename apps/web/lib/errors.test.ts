import { describe, expect, it } from 'vitest';
import { authProblem } from './errors';

describe('AD-06 phone sign-in messages', () => {
  it('turns the phone-number plugin’s codes into plain words', () => {
    expect(
      authProblem({ status: 400, code: 'INVALID_PHONE_NUMBER', message: 'x' }).message,
    ).toMatch(/valid phone number/);
    expect(authProblem({ status: 400, code: 'INVALID_OTP', message: 'Invalid OTP' }).message).toBe(
      'That code is not right, or it has expired. Check the SMS, or ask for a new code.',
    );
    expect(authProblem({ status: 400, code: 'OTP_EXPIRED', message: 'OTP expired' }).message).toBe(
      'That code has expired. Ask for a new one.',
    );
    expect(authProblem({ status: 403, code: 'TOO_MANY_ATTEMPTS', message: 'x' }).message).toBe(
      'Too many wrong codes. Ask for a new code.',
    );
  });

  it('says how long to wait: a number with too many codes is not a one-minute pause', () => {
    expect(authProblem({ status: 429, code: 'TOO_MANY_CODES', message: 'x' }).message).toMatch(
      /Too many codes have been sent to this number/,
    );
    // A rate limit with no code of its own keeps the general message.
    expect(authProblem({ status: 429, message: 'Too many requests' }).message).toBe(
      'Too many attempts. Wait a minute and try again.',
    );
  });

  it('keeps the existing password and TOTP messages', () => {
    expect(authProblem({ status: 401, code: 'INVALID_CODE' }).message).toMatch(
      /That code is not right/,
    );
    expect(authProblem({ status: 401 }).code).toBe('not_authenticated');
    expect(authProblem(new TypeError('fetch failed')).code).toBe('network');
  });
});
