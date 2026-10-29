import { and, desc, eq, schema, withCompany, type Database } from '@rent/db';
import type { CompanyKeyStore, StoredKey } from './field-cipher';

const PURPOSE = 'field_encryption';

/** Wrapped data keys in company_key (append-only; one row per version). */
export class DbKeyStore implements CompanyKeyStore {
  constructor(private readonly database: Database) {}

  latest(companyId: string): Promise<StoredKey | null> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.companyKey)
        .where(
          and(eq(schema.companyKey.companyId, companyId), eq(schema.companyKey.purpose, PURPOSE)),
        )
        .orderBy(desc(schema.companyKey.version))
        .limit(1);
      return row ? { version: row.version, wrapped: row.wrappedKey, kmsKeyId: row.kmsKeyId } : null;
    });
  }

  get(companyId: string, version: number): Promise<StoredKey | null> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.companyKey)
        .where(
          and(
            eq(schema.companyKey.companyId, companyId),
            eq(schema.companyKey.purpose, PURPOSE),
            eq(schema.companyKey.version, version),
          ),
        );
      return row ? { version: row.version, wrapped: row.wrappedKey, kmsKeyId: row.kmsKeyId } : null;
    });
  }

  insert(companyId: string, key: StoredKey): Promise<boolean> {
    return withCompany(this.database, { companyId, actorKind: 'system' }, async (tx) => {
      const rows = await tx
        .insert(schema.companyKey)
        .values({
          companyId,
          purpose: PURPOSE,
          version: key.version,
          wrappedKey: key.wrapped,
          kmsKeyId: key.kmsKeyId,
        })
        .onConflictDoNothing()
        .returning({ id: schema.companyKey.id });
      return rows.length === 1;
    });
  }
}
