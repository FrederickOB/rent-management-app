import { createHash, timingSafeEqual } from 'node:crypto';

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * The fingerprint of a document (ADR-006): SHA-256 over its final bytes, lowercase hex. It is
 * stored on the `document` row and written into the audit chain.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** True when `bytes` hash to `expectedHex`. A malformed fingerprint never matches. */
export function verifyFingerprint(bytes: Uint8Array, expectedHex: string): boolean {
  if (!SHA256_HEX.test(expectedHex)) return false;
  const actual = createHash('sha256').update(bytes).digest();
  // Constant time, so a caller cannot learn how much of a guessed fingerprint was right.
  return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
}
