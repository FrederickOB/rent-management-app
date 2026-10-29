import { createHmac, timingSafeEqual } from 'node:crypto';

export type HmacAlgorithm = 'sha256' | 'sha512';

/** HMAC of a raw request body, hex-encoded, as providers sign their webhooks. */
export function hmacHex(algorithm: HmacAlgorithm, key: string, data: Buffer | string): string {
  return createHmac(algorithm, key).update(data).digest('hex');
}

/** Compares a received hex signature with the expected one in constant time. */
export function signatureMatches(
  algorithm: HmacAlgorithm,
  key: string,
  data: Buffer | string,
  received: string,
): boolean {
  const expected = createHmac(algorithm, key).update(data).digest();
  // Buffer.from(hex) silently stops at the first bad character, so check the format first.
  if (received.length !== expected.length * 2 || !/^[0-9a-f]+$/i.test(received)) return false;
  return timingSafeEqual(expected, Buffer.from(received, 'hex'));
}
