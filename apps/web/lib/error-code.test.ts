import { describe, expect, it } from 'vitest';
import { errorCode } from './errors';

describe('BC-05 and plan 4.15 the API’s refusal codes, read one way', () => {
  it('reads a contract handler’s code and a guard’s body code alike, in capitals', () => {
    expect(
      errorCode(Object.assign(new Error('refused'), { status: 409, code: 'CASH_SHORT' })),
    ).toBe('CASH_SHORT');
    expect(
      errorCode(
        Object.assign(new Error('refused'), {
          status: 400,
          code: 'BAD_REQUEST',
          data: { body: { code: 'upload_expired' } },
        }),
      ),
    ).toBe('UPLOAD_EXPIRED');
  });

  it('reads nothing where no code was sent', () => {
    expect(errorCode({ status: 409 })).toBe('');
    expect(errorCode(new TypeError('Failed to fetch'))).toBe('');
    expect(errorCode(null)).toBe('');
  });
});
