import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Tokens, codes and keyed hashes for signing (CLAUDE.md section 9). A link carries 256 random
 * bits and only their SHA-256 is stored. A one-time code is stored as an HMAC, keyed from the
 * server secret, so reading the database is not enough to try codes offline. Phones, emails and
 * IP addresses that rate limits count are kept only as keyed hashes too.
 */

/** 32 random bytes, base64url: 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const newToken = (): string => randomBytes(32).toString('base64url');

export const tokenHash = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** Six digits, uniformly random. */
export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

export const sha256Text = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export class SigningHasher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'rent-esign', 'signing-code-hash', 32));
  }

  private mac(...parts: string[]): string {
    return createHmac('sha256', this.key).update(parts.join('\u001f')).digest('hex');
  }

  /** The stored form of a code, bound to its challenge. */
  code(challengeId: string, code: string): string {
    return this.mac('code', challengeId, code);
  }

  codeMatches(challengeId: string, code: string, stored: string): boolean {
    const candidate = Buffer.from(this.code(challengeId, code), 'hex');
    const expected = Buffer.from(stored, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  /** A phone number or email, for the per-destination send limit. */
  destination(address: string): string {
    return this.mac('destination', address.trim().toLowerCase());
  }

  /** An IP address, for the per-address limits. */
  address(ip: string): string {
    return this.mac('ip', ip.trim().toLowerCase());
  }
}
