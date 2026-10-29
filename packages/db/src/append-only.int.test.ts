import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { APPEND_ONLY_TABLES } from './append-only';
import { cloneTemplateDatabase, runSql, type TestDatabase } from './testing';
import { connect, createCompany, inContext, sqlState } from './testing/fixtures';

let db: TestDatabase;
let app: pg.Client;
let owner: pg.Client;
let companyId: string;

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  // A test-only table, as the playbook asks, set up exactly as the ledger tables will be in M4a.
  await runSql(
    db.ownerUrl,
    `create table append_only_probe (id uuid primary key default uuidv7(), company_id uuid not null references company (id), note text not null);
     select app.enable_company_rls('append_only_probe');
     select app.make_append_only('append_only_probe');
     -- Grant the privileges back, to prove the trigger refuses even a role that holds them.
     grant select, insert, update, delete, truncate on append_only_probe to rent_app;`,
  );
  app = await connect(db.appUrl);
  owner = await connect(db.ownerUrl);
  companyId = await createCompany(app, 'Probe Company');
  await inContext(app, { companyId }, () =>
    app.query("insert into append_only_probe (company_id, note) values ($1, 'first')", [companyId]),
  );
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await db?.drop();
});

describe('NFR-AUDIT append-only', () => {
  it('rejects UPDATE, DELETE and TRUNCATE from the application role', async () => {
    expect(
      await sqlState(
        inContext(app, { companyId }, () =>
          app.query("update append_only_probe set note = 'changed'"),
        ),
      ),
    ).toBe('RA001');
    expect(
      await sqlState(
        inContext(app, { companyId }, () => app.query('delete from append_only_probe')),
      ),
    ).toBe('RA001');
    expect(
      await sqlState(inContext(app, { companyId }, () => app.query('truncate append_only_probe'))),
    ).toBe('RA001');
  });

  it('rejects them from the table owner too', async () => {
    expect(
      await sqlState(
        inContext(owner, { companyId }, () =>
          owner.query("update append_only_probe set note = 'changed'"),
        ),
      ),
    ).toBe('RA001');
    expect(
      await sqlState(
        inContext(owner, { companyId }, () => owner.query('delete from append_only_probe')),
      ),
    ).toBe('RA001');
    expect(await sqlState(owner.query('truncate append_only_probe'))).toBe('RA001');
    const rows = await runSql<{ note: string }>(
      db.superuserUrl,
      'select note from append_only_probe',
    );
    expect(rows).toEqual([{ note: 'first' }]);
  });

  it('still accepts new rows', async () => {
    await inContext(app, { companyId }, () =>
      app.query("insert into append_only_probe (company_id, note) values ($1, 'second')", [
        companyId,
      ]),
    );
    const rows = await runSql(db.superuserUrl, 'select note from append_only_probe');
    expect(rows).toHaveLength(2);
  });

  it('protects every table listed as append-only, with triggers and without UPDATE or DELETE privileges', async () => {
    for (const table of APPEND_ONLY_TABLES) {
      const triggers = await runSql<{ tgname: string }>(
        db.ownerUrl,
        "select tgname from pg_trigger where tgrelid = $1::regclass and tgname like 'append_only_%' order by 1",
        [table],
      );
      expect(
        triggers.map((t) => t.tgname),
        table,
      ).toEqual(['append_only_row', 'append_only_truncate']);
      const [privileges] = await runSql<{ upd: boolean; del: boolean; trunc: boolean }>(
        db.ownerUrl,
        "select has_any_column_privilege('rent_app', $1, 'UPDATE') as upd, has_table_privilege('rent_app', $1, 'DELETE') as del, has_table_privilege('rent_app', $1, 'TRUNCATE') as trunc",
        [table],
      );
      expect(privileges, table).toEqual({ upd: false, del: false, trunc: false });
    }
  });
});
