import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex, verifyFingerprint } from './fingerprint';

describe('PLATFORM documents', () => {
  describe('fingerprints', () => {
    it('is SHA-256 in lowercase hex', () => {
      // FIPS 180-2 test vector.
      expect(sha256Hex(Buffer.from('abc'))).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
      const bytes = Buffer.from('%PDF-1.7 a document');
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    });

    it('verifies the bytes it was taken from', () => {
      const bytes = Buffer.from('%PDF-1.7 a document');
      expect(verifyFingerprint(bytes, sha256Hex(bytes))).toBe(true);
      expect(verifyFingerprint(bytes, sha256Hex(bytes).toUpperCase())).toBe(true);
    });

    it('detects a single changed byte, wherever it is', () => {
      const bytes = Buffer.from('%PDF-1.7 a document');
      const fingerprint = sha256Hex(bytes);
      for (let i = 0; i < bytes.length; i += 1) {
        const changed = Buffer.from(bytes);
        changed[i] = (changed[i] ?? 0) ^ 0x01;
        expect(verifyFingerprint(changed, fingerprint)).toBe(false);
      }
    });

    it('never matches a malformed fingerprint', () => {
      const bytes = Buffer.from('x');
      const fingerprint = sha256Hex(bytes);
      expect(verifyFingerprint(bytes, '')).toBe(false);
      expect(verifyFingerprint(bytes, fingerprint.slice(1))).toBe(false);
      expect(verifyFingerprint(bytes, `${fingerprint}00`)).toBe(false);
      expect(verifyFingerprint(bytes, `${fingerprint.slice(0, 63)}g`)).toBe(false);
    });
  });
});
