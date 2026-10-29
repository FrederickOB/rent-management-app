import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * One-time codes are stored as an HMAC, never in plain text (CLAUDE.md section 9). The key is
 * derived from the auth secret, so someone who can read the database still cannot brute-force
 * a 6-digit code offline.
 */
export class OtpHasher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'rent-otp', 'one-time-code-hash', 32));
  }

  hash(identifier: string, code: string): string {
    return createHmac('sha256', this.key).update(`${identifier}\u001f${code}`).digest('hex');
  }

  matches(identifier: string, code: string, stored: string): boolean {
    const candidate = Buffer.from(this.hash(identifier, code), 'hex');
    const expected = Buffer.from(stored, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
}

/** Better Auth stores `code:attempts`; a plain code is exactly six digits before the colon. */
export const PLAIN_CODE_VALUE = /^(\d{6}):(\d+)$/;
export const HASHED_CODE_VALUE = /^([0-9a-f]{64}):(\d+)$/;
