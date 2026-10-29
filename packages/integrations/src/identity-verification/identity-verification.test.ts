import { describe, expect, it } from 'vitest';
import { fakeIdNumbers, identityVerificationContract } from '../testing';
import { fakeIdentityOutcome, InMemoryIdentityVerification } from './identity-verification';

identityVerificationContract('in-memory', () => ({
  port: new InMemoryIdentityVerification(),
  idNumbers: fakeIdNumbers,
}));

describe('PLATFORM identity verification fake outcomes', () => {
  it('follows the documented last-digit rule', () => {
    expect(fakeIdentityOutcome('GHA-123456789-0')).toBe('not_matched');
    expect(fakeIdentityOutcome('GHA-123456789-9')).toBe('failed');
    expect(fakeIdentityOutcome('GHA-123456789-8')).toBe('pending');
    for (const last of ['1', '2', '3', '4', '5', '6', '7']) {
      expect(fakeIdentityOutcome(`GHA-123456789-${last}`)).toBe('verified');
    }
    expect(fakeIdentityOutcome('g1234567')).toBe('verified');
  });

  it('accepts a Ghana Card number typed in lower case', async () => {
    const port = new InMemoryIdentityVerification();
    const started = await port.startCheck({
      idType: 'ghana_card',
      idNumber: ' gha-123456789-1 ',
      reference: 'tenant-1',
    });
    expect(started.checkId).not.toBe('');
  });
});
