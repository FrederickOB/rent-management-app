import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyManagementPort } from '@rent/integrations';

/**
 * Field-level encryption for ID numbers and bank and MoMo account numbers (CLAUDE.md section 10).
 * Envelope encryption: KMS wraps a per-company data key; each value is AES-256-GCM with a
 * random IV, and the AAD binds it to its company, table, column and row, so a ciphertext copied
 * to another row or company fails to decrypt.
 */
export interface FieldContext {
  readonly companyId: string;
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

export interface StoredKey {
  readonly version: number;
  readonly wrapped: Buffer;
  readonly kmsKeyId: string;
}

/** Where wrapped data keys live: the company_key table in production, memory in unit tests. */
export interface CompanyKeyStore {
  latest(companyId: string): Promise<StoredKey | null>;
  get(companyId: string, version: number): Promise<StoredKey | null>;
  /** Stores a new version; false if another writer created it first. */
  insert(companyId: string, key: StoredKey): Promise<boolean>;
}

const FORMAT_V1 = 0x01;
const PURPOSE = 'field_encryption';

export class FieldCipher {
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly kms: KeyManagementPort,
    private readonly keys: CompanyKeyStore,
    private readonly blindIndexMaster: Buffer,
  ) {
    if (blindIndexMaster.length !== 32)
      throw new Error('BLIND_INDEX_MASTER_KEY must be 32 bytes, base64-encoded');
  }

  async encrypt(ctx: FieldContext, plaintext: string): Promise<Buffer> {
    const { version, key } = await this.currentKey(ctx.companyId);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad(ctx));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const header = Buffer.alloc(5);
    header.writeUInt8(FORMAT_V1, 0);
    header.writeUInt32BE(version, 1);
    return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
  }

  async decrypt(ctx: FieldContext, ciphertext: Buffer): Promise<string> {
    if (ciphertext.length < 33 || ciphertext.readUInt8(0) !== FORMAT_V1)
      throw new Error('Unknown ciphertext format');
    const version = ciphertext.readUInt32BE(1);
    const key = await this.keyVersion(ctx.companyId, version);
    // An explicit tag length, so a shortened tag is refused rather than accepted.
    const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(5, 17), {
      authTagLength: 16,
    });
    decipher.setAAD(aad(ctx));
    decipher.setAuthTag(ciphertext.subarray(17, 33));
    return Buffer.concat([decipher.update(ciphertext.subarray(33)), decipher.final()]).toString(
      'utf8',
    );
  }

  /** Keyed hash for equality lookups. Per company, so equal values in two companies differ. */
  blindIndex(companyId: string, normalised: string): string {
    const companyKey = Buffer.from(
      hkdfSync('sha256', this.blindIndexMaster, companyId, 'blind-index', 32),
    );
    return createHmac('sha256', companyKey).update(normalised, 'utf8').digest('hex');
  }

  /** Starts a new key version for new writes. Old versions stay readable. */
  async rotate(companyId: string): Promise<number> {
    const latest = await this.keys.latest(companyId);
    const version = (latest?.version ?? 0) + 1;
    const dataKey = await this.kms.generateDataKey(kmsContext(companyId, version));
    if (
      !(await this.keys.insert(companyId, {
        version,
        wrapped: dataKey.wrapped,
        kmsKeyId: dataKey.keyId,
      }))
    ) {
      throw new Error('Key rotation raced with another writer; try again');
    }
    this.cache.set(`${companyId}:${version}`, dataKey.plaintext);
    return version;
  }

  private async currentKey(companyId: string): Promise<{ version: number; key: Buffer }> {
    const latest = await this.keys.latest(companyId);
    if (latest)
      return { version: latest.version, key: await this.keyVersion(companyId, latest.version) };
    try {
      const version = await this.rotate(companyId);
      return { version, key: await this.keyVersion(companyId, version) };
    } catch {
      // Another writer created version 1 first; use theirs.
      const created = await this.keys.latest(companyId);
      if (!created) throw new Error('Could not create a data key');
      return { version: created.version, key: await this.keyVersion(companyId, created.version) };
    }
  }

  private async keyVersion(companyId: string, version: number): Promise<Buffer> {
    const cacheKey = `${companyId}:${version}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const stored = await this.keys.get(companyId, version);
    if (!stored) throw new Error(`No data key version ${version} for this company`);
    const key = await this.kms.decryptDataKey(stored.wrapped, kmsContext(companyId, version));
    this.cache.set(cacheKey, key);
    return key;
  }
}

// JSON, so no two different contexts share an encoding.
const aad = (ctx: FieldContext) =>
  Buffer.from(JSON.stringify([ctx.companyId, ctx.table, ctx.column, ctx.rowId]), 'utf8');
const kmsContext = (companyId: string, version: number) => ({
  companyId,
  purpose: PURPOSE,
  version: String(version),
});

export class InMemoryKeyStore implements CompanyKeyStore {
  private readonly keys = new Map<string, StoredKey[]>();
  latest(companyId: string) {
    return Promise.resolve(this.keys.get(companyId)?.at(-1) ?? null);
  }
  get(companyId: string, version: number) {
    return Promise.resolve(this.keys.get(companyId)?.find((k) => k.version === version) ?? null);
  }
  insert(companyId: string, key: StoredKey) {
    const list = this.keys.get(companyId) ?? [];
    if (list.some((k) => k.version === key.version)) return Promise.resolve(false);
    this.keys.set(companyId, [...list, key]);
    return Promise.resolve(true);
  }
}

/** Masks an ID number for display, keeping the prefix and the last three characters: GHA-*******89-0. */
export function maskIdNumber(value: string): string {
  if (value.length <= 4) return '****';
  const keepEnd = 4;
  const start = value.startsWith('GHA-') ? 4 : 0;
  return (
    value.slice(0, start) +
    value.slice(start, -keepEnd).replace(/[0-9A-Za-z]/g, '*') +
    value.slice(-keepEnd)
  );
}
