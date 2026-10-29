import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LocalKms } from '@rent/integrations';
import { FieldCipher, InMemoryKeyStore, maskIdNumber } from './field-cipher';

const kms = new LocalKms(randomBytes(32).toString('base64'));
const ctx = {
  companyId: '019a3000-0000-7000-8000-000000000002',
  table: 'tenant',
  column: 'id_number',
  rowId: 'row-1',
};
const newCipher = () => new FieldCipher(kms, new InMemoryKeyStore(), randomBytes(32));

describe('NFR-SEC field encryption', () => {
  it('round-trips any value', async () => {
    const cipher = newCipher();
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 64 }), async (value) => {
        expect(await cipher.decrypt(ctx, await cipher.encrypt(ctx, value))).toBe(value);
      }),
      { numRuns: 50 },
    );
  });

  it('never repeats a ciphertext for the same value', async () => {
    const cipher = newCipher();
    const a = await cipher.encrypt(ctx, 'GHA-123456789-0');
    const b = await cipher.encrypt(ctx, 'GHA-123456789-0');
    expect(a.equals(b)).toBe(false);
    expect(a.toString('utf8')).not.toContain('123456789');
  });

  it('fails authentication when one byte changes', async () => {
    const cipher = newCipher();
    const sealed = await cipher.encrypt(ctx, 'GHA-123456789-0');
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    await expect(cipher.decrypt(ctx, tampered)).rejects.toThrow();
  });

  it('refuses a ciphertext moved to another row, column or company', async () => {
    const cipher = newCipher();
    const sealed = await cipher.encrypt(ctx, 'GHA-123456789-0');
    await expect(cipher.decrypt({ ...ctx, rowId: 'row-2' }, sealed)).rejects.toThrow();
    await expect(cipher.decrypt({ ...ctx, column: 'account_number' }, sealed)).rejects.toThrow();
    await expect(
      cipher.decrypt({ ...ctx, companyId: '019a3000-0000-7000-8000-000000000003' }, sealed),
    ).rejects.toThrow();
  });

  it('keeps old values readable after key rotation, and writes new ones with the new key', async () => {
    const cipher = newCipher();
    const before = await cipher.encrypt(ctx, 'old value');
    const version = await cipher.rotate(ctx.companyId);
    expect(version).toBe(2);
    const after = await cipher.encrypt(ctx, 'new value');
    expect(after.readUInt32BE(1)).toBe(2);
    expect(await cipher.decrypt(ctx, before)).toBe('old value');
    expect(await cipher.decrypt(ctx, after)).toBe('new value');
  });

  it('gives a stable blind index within a company and a different one across companies', () => {
    const cipher = newCipher();
    const a1 = cipher.blindIndex(ctx.companyId, 'GHA-123456789-0');
    const a2 = cipher.blindIndex(ctx.companyId, 'GHA-123456789-0');
    const b = cipher.blindIndex('019a3000-0000-7000-8000-000000000003', 'GHA-123456789-0');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('masks ID numbers for display', () => {
    expect(maskIdNumber('GHA-123456789-0')).toBe('GHA-*******89-0');
    expect(maskIdNumber('P1234567')).toBe('****4567');
  });
});
