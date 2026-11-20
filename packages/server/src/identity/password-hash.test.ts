import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  needsRehash,
  OWASP_SCRYPT,
  TEST_SCRYPT,
  verifyPassword,
} from './password-hash';

/** Better Auth's default hash before M11: `salt:key`, scrypt N=2^14, r=16, p=1, salt used as text. */
function legacyHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `${salt}:${key.toString('hex')}`;
}

describe('NFR-SEC M11 review R1 F12: password hashing at OWASP’s scrypt minimum', () => {
  it('hashes at N=2^14, r=8, p=5 (16 MiB per hash) and verifies only the right password', async () => {
    expect(OWASP_SCRYPT).toEqual({ N: 16384, r: 8, p: 5 });
    const hash = await hashPassword('correct horse battery staple', OWASP_SCRYPT);
    expect(hash).toMatch(/^\$scrypt\$n=16384,r=8,p=5\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stapl')).toBe(false);
    expect(needsRehash(hash, OWASP_SCRYPT)).toBe(false);
    // Each hash has its own salt.
    expect(await hashPassword('correct horse battery staple', OWASP_SCRYPT)).not.toBe(hash);
  });

  it('still verifies Better Auth’s older hashes, and marks them (and other costs) for rehashing', async () => {
    const old = legacyHash('an older password here');
    expect(await verifyPassword(old, 'an older password here')).toBe(true);
    expect(await verifyPassword(old, 'not the older password')).toBe(false);
    expect(needsRehash(old, OWASP_SCRYPT)).toBe(true);
    const cheap = await hashPassword('x'.repeat(12), TEST_SCRYPT);
    expect(needsRehash(cheap, OWASP_SCRYPT)).toBe(true);
  });

  it('refuses a malformed or absurd stored hash instead of trying it', async () => {
    expect(await verifyPassword('$scrypt$n=1073741824,r=8,p=1$AAAA$AAAA', 'x')).toBe(false);
    expect(await verifyPassword('$scrypt$garbage', 'x')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
