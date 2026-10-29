import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Key management (CLAUDE.md section 10): generates and unwraps data keys. AWS KMS replaces the
 * local adapter at first deployment; the local one keeps a master key in the environment.
 */
export interface DataKey {
  readonly plaintext: Buffer;
  /** The data key encrypted under the master key; safe to store. */
  readonly wrapped: Buffer;
  readonly keyId: string;
}

export interface KeyManagementPort {
  readonly keyId: string;
  generateDataKey(context: Record<string, string>): Promise<DataKey>;
  decryptDataKey(wrapped: Buffer, context: Record<string, string>): Promise<Buffer>;
}

// JSON of the sorted pairs: no two different contexts share an encoding. (A `k=v&k=v` join let
// {a: '1&b=2'} unwrap a key made for {a: '1', b: '2'}.)
const contextAad = (context: Record<string, string>) =>
  Buffer.from(
    JSON.stringify(
      Object.keys(context)
        .sort()
        .map((k) => [k, context[k]]),
    ),
    'utf8',
  );

const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_BYTES = IV_BYTES + TAG_BYTES + 32;

/** AES-256-GCM key wrapping under a 32-byte master key. Encryption context is bound as AAD, as in AWS KMS. */
export class LocalKms implements KeyManagementPort {
  readonly keyId: string;
  private readonly master: Buffer;

  constructor(masterKeyBase64: string, keyId = 'local-kms-v1') {
    this.master = Buffer.from(masterKeyBase64, 'base64');
    if (this.master.length !== 32)
      throw new Error('LOCAL_KMS_MASTER_KEY must be 32 bytes, base64-encoded');
    this.keyId = keyId;
  }

  // Async, so a failure rejects the promise instead of throwing at the call site.
  async generateDataKey(context: Record<string, string>): Promise<DataKey> {
    const plaintext = randomBytes(32);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(contextAad(context));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrapped = Buffer.concat([iv, cipher.getAuthTag(), body]);
    return { plaintext, wrapped, keyId: this.keyId };
  }

  async decryptDataKey(wrapped: Buffer, context: Record<string, string>): Promise<Buffer> {
    if (wrapped.length !== WRAPPED_BYTES) throw new Error('wrapped data key has the wrong length');
    const iv = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    // An explicit tag length, so a shortened tag is refused rather than accepted (Node DEP0182).
    const decipher = createDecipheriv('aes-256-gcm', this.master, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(contextAad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(wrapped.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  }
}
