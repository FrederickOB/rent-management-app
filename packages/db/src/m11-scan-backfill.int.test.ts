import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseMigratedTo, runSql } from './testing';
import { connect, createCompany, inContext } from './testing/fixtures';

/**
 * M11 decision 6 (migration 0068): every document stored before scanning existed is given a
 * `pre_m11` clean result, so none is left pending. Proven on a database migrated to 0067, given a
 * document, then migrated the rest of the way (a cloned template has no pre-M11 rows, so the
 * check in m11-security.int.test.ts could not show it).
 */
let db: Awaited<ReturnType<typeof createDatabaseMigratedTo>>;
let documentId: string;
let companyId: string;

beforeAll(async () => {
  db = await createDatabaseMigratedTo('scanfill', '0067_m11_schema');
  const app = await connect(db.appUrl);
  try {
    companyId = await createCompany(app, 'Before Scanning');
    documentId = await inContext(app, { companyId }, async () => {
      const { rows } = await app.query<{ id: string }>(
        `insert into document (company_id, kind, content_type, size_bytes, sha256, bucket, storage_key, write_once)
         values ($1, 'property_file', 'application/pdf', 10, $2, 'files', 'k/pre-m11', false) returning id`,
        [companyId, 'a'.repeat(64)],
      );
      return rows[0]!.id;
    });
  } finally {
    await app.end();
  }
  await db.migrateRest();
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

describe('NFR-SEC documents stored before M11 get a scan result (M11 decision 6)', () => {
  it('records a pre_m11 clean result for a document that existed before 0068', async () => {
    const rows = await runSql<{ status: string; engine: string; finding: string | null }>(
      db.superuserUrl,
      'select status, engine, finding from document_scan where company_id = $1 and document_id = $2',
      [companyId, documentId],
    );
    expect(rows).toEqual([{ status: 'clean', engine: 'pre_m11', finding: null }]);
  });
});
