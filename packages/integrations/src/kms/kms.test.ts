import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LocalKms } from './kms';

const masterKey = () => randomBytes(32).toString('base64');
const context = { company: '0192c7a4-0000-7000-8000-000000000001', purpose: 'company_key' };

describe('NFR-SEC key management: LocalKms', () => {
  it('unwraps the data key it generated, under the same encryption context', async () => {
    const kms = new LocalKms(masterKey());
    const key = await kms.generateDataKey(context);
    expect(key.plaintext).toHaveLength(32);
    expect(key.keyId).toBe('local-kms-v1');
    expect(key.wrapped.equals(key.plaintext)).toBe(false);
    expect((await kms.decryptDataKey(key.wrapped, context)).equals(key.plaintext)).toBe(true);
  });

  it('does not depend on the order of the context keys', async () => {
    const kms = new LocalKms(masterKey());
    const key = await kms.generateDataKey({ a: '1', b: '2' });
    expect((await kms.decryptDataKey(key.wrapped, { b: '2', a: '1' })).equals(key.plaintext)).toBe(
      true,
    );
  });

  it('generates a different data key and wrapping each time', async () => {
    const kms = new LocalKms(masterKey());
    const [one, two] = await Promise.all([
      kms.generateDataKey(context),
      kms.generateDataKey(context),
    ]);
    expect(one.plaintext.equals(two.plaintext)).toBe(false);
    expect(one.wrapped.equals(two.wrapped)).toBe(false);
  });

  it('refuses a different encryption context', async () => {
    const kms = new LocalKms(masterKey());
    const key = await kms.generateDataKey(context);
    await expect(
      kms.decryptDataKey(key.wrapped, { ...context, company: 'another-company' }),
    ).rejects.toThrow();
    await expect(kms.decryptDataKey(key.wrapped, { company: context.company })).rejects.toThrow();
    await expect(kms.decryptDataKey(key.wrapped, {})).rejects.toThrow();
  });

  it('refuses a context that only joins to the same text as the original', async () => {
    // {a: '1&b=2'} and {a: '1', b: '2'} are different contexts and must not unwrap each other's keys.
    const kms = new LocalKms(masterKey());
    const key = await kms.generateDataKey({ a: '1&b=2' });
    await expect(kms.decryptDataKey(key.wrapped, { a: '1', b: '2' })).rejects.toThrow();
    const other = await kms.generateDataKey({ 'a=1': 'x' });
    await expect(kms.decryptDataKey(other.wrapped, { a: '1=x' })).rejects.toThrow();
  });

  it('refuses a wrapped key with any byte changed: IV, tag or body', async () => {
    const kms = new LocalKms(masterKey());
    const key = await kms.generateDataKey(context);
    for (const index of [0, 11, 12, 27, 28, key.wrapped.length - 1]) {
      const tampered = Buffer.from(key.wrapped);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      await expect(kms.decryptDataKey(tampered, context)).rejects.toThrow();
    }
  });

  it('refuses a truncated or extended wrapped key with a rejected promise', async () => {
    const kms = new LocalKms(masterKey());
    const key = await kms.generateDataKey(context);
    for (const wrapped of [
      Buffer.alloc(0),
      key.wrapped.subarray(0, 20),
      key.wrapped.subarray(0, key.wrapped.length - 1),
      Buffer.concat([key.wrapped, Buffer.from([0])]),
    ]) {
      await expect(kms.decryptDataKey(wrapped, context)).rejects.toThrow();
    }
  });

  it('refuses a key wrapped under another master key', async () => {
    const key = await new LocalKms(masterKey()).generateDataKey(context);
    await expect(new LocalKms(masterKey()).decryptDataKey(key.wrapped, context)).rejects.toThrow();
  });

  it('refuses a master key that is not 32 bytes', () => {
    expect(() => new LocalKms(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => new LocalKms(randomBytes(33).toString('base64'))).toThrow(/32 bytes/);
    expect(() => new LocalKms('')).toThrow(/32 bytes/);
  });

  it('reports the key id it was given', async () => {
    const kms = new LocalKms(masterKey(), 'local-kms-v2');
    expect(kms.keyId).toBe('local-kms-v2');
    expect((await kms.generateDataKey(context)).keyId).toBe('local-kms-v2');
  });
});
