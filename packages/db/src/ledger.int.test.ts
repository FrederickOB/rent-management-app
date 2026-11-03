import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { cloneTemplateDatabase, runSql, type TestDatabase } from './testing';
import { connect, createCompany, inContext, sqlState } from './testing/fixtures';

/**
 * The journal in the database (ADR-003; M4a plan 4.2), with raw SQL below the application: only
 * ledger_writer inserts, nobody updates or deletes, and at commit every entry has two lines or
 * more and sums to zero in each book. Accounts stay in their kind of book and locked months take
 * no lines.
 */
let db: TestDatabase;
let app: pg.Client;
let companyId: string;
let ownerBook: string;
let companyBook: string;

const entry = (id: string, key: string, accounting = 'current_date') =>
  // eslint-disable-next-line rent/ledger-writes -- proves the database's rules for journal writes
  `insert into journal_entry (id, company_id, rule, idempotency_key, value_date, accounting_date, record_type, record_id)
   values ('${id}', '${companyId}', 'P02', '${key}', current_date, ${accounting}, 'test', '${id}')`;
const line = (entryId: string, no: number, book: string, account: string, amount: number) =>
  // eslint-disable-next-line rent/ledger-writes -- proves the database's rules for journal writes
  `insert into journal_line (id, company_id, entry_id, line_no, book_id, account_code, amount_minor)
   values ('${randomUUID()}', '${companyId}', '${entryId}', ${no}, '${book}', '${account}', ${amount})`;

/** Runs statements as ledger_writer in one company transaction, as the posting service does. */
async function asWriter(statements: string[]): Promise<void> {
  await inContext(app, { companyId }, async () => {
    await app.query('set local role ledger_writer');
    for (const statement of statements) await app.query(statement);
  });
}

beforeAll(async () => {
  db = await cloneTemplateDatabase(inject('templateDatabase'));
  app = await connect(db.appUrl);
  companyId = await createCompany(app, 'Ledger Company', 'agency');
  await inContext(app, { companyId }, async () => {
    await app.query(
      "insert into owner (company_id, reference, kind, display_name) values ($1, 'OWN-01', 'individual', 'Owner')",
      [companyId],
    );
    const books = await app.query<{ id: string; kind: string }>('select id, kind from book');
    const byKind = Object.fromEntries(books.rows.map((r) => [r.kind, r.id]));
    ownerBook = byKind.owner!;
    companyBook = byKind.company!;
  });
});

afterAll(async () => {
  await app?.end();
  await db?.drop();
});

describe('AC-01 books are made by the database', () => {
  it('gives each new owner and each landlord or agency company its book, and nobody else may add one', async () => {
    expect(ownerBook).toBeDefined();
    expect(companyBook).toBeDefined();
    const state = await sqlState(
      inContext(app, { companyId }, () =>
        app.query("insert into book (company_id, kind) values ($1, 'company')", [companyId]),
      ),
    );
    expect(state).toBe('42501');
  });
});

describe('AC-01 the journal is append-only', () => {
  it('lets only ledger_writer insert: the application role is refused, by grant and by trigger', async () => {
    const id = randomUUID();
    expect(
      await sqlState(inContext(app, { companyId }, () => app.query(entry(id, `a:${id}`)))),
    ).toMatch(/^(42501|RA040)$/);
    const owner = await connect(db.ownerUrl);
    try {
      expect(
        await sqlState(inContext(owner, { companyId }, () => owner.query(entry(id, `b:${id}`)))),
      ).toBe('RA040');
    } finally {
      await owner.end();
    }
  });

  it('accepts a balanced entry from ledger_writer, and refuses its update or delete by anyone', async () => {
    const id = randomUUID();
    await asWriter([
      entry(id, `ok:${id}`),
      line(id, 1, ownerBook, '1100', 1_000),
      line(id, 2, ownerBook, '4000', -1_000),
    ]);
    for (const statement of [
      `update journal_line set amount_minor = 5 where entry_id = '${id}'`,
      `delete from journal_line where entry_id = '${id}'`,
      `update journal_entry set rule = 'P03' where id = '${id}'`,
      `delete from journal_entry where id = '${id}'`,
    ]) {
      expect(
        await sqlState(inContext(app, { companyId }, () => app.query(statement))),
        statement,
      ).toMatch(/^(42501|RA001)$/);
      expect(
        await sqlState(
          inContext(app, { companyId }, async () => {
            await app.query('set local role ledger_writer');
            await app.query(statement);
          }),
        ),
        `ledger_writer: ${statement}`,
      ).toMatch(/^(42501|RA001)$/);
    }
    const rows = await runSql(
      db.superuserUrl,
      `select count(*)::int as n from journal_line where entry_id = '${id}'`,
    );
    expect(rows).toEqual([{ n: 2 }]);
  });

  it('refuses at commit an entry that does not balance in a book, or has one line', async () => {
    const unbalanced = randomUUID();
    expect(
      await sqlState(
        asWriter([
          entry(unbalanced, `u:${unbalanced}`),
          line(unbalanced, 1, ownerBook, '1100', 1_000),
          line(unbalanced, 2, ownerBook, '4000', -999),
        ]),
      ),
    ).toBe('RA042');
    // Two books each balancing is fine; one book off is not, even when the entry sums to zero.
    const crossBooks = randomUUID();
    expect(
      await sqlState(
        asWriter([
          entry(crossBooks, `c:${crossBooks}`),
          line(crossBooks, 1, ownerBook, '1070', 500),
          line(crossBooks, 2, companyBook, '1070', -500),
        ]),
      ),
    ).toBe('RA042');
    const single = randomUUID();
    expect(
      await sqlState(
        asWriter([entry(single, `s:${single}`), line(single, 1, ownerBook, '1100', 0 + 1)]),
      ),
    ).toMatch(/^RA04[12]$/);
    const none = randomUUID();
    expect(await sqlState(asWriter([entry(none, `n:${none}`)]))).toBe('RA041');
  });

  it('keeps each account in its kind of book', async () => {
    const id = randomUUID();
    expect(
      await sqlState(
        asWriter([
          entry(id, `k:${id}`),
          line(id, 1, companyBook, '2010', 100),
          line(id, 2, companyBook, '1010', -100),
        ]),
      ),
    ).toBe('RA043');
  });

  it('refuses a line for an entry written in another transaction', async () => {
    const id = randomUUID();
    await asWriter([
      entry(id, `t:${id}`),
      line(id, 1, ownerBook, '1100', 10),
      line(id, 2, ownerBook, '4000', -10),
    ]);
    expect(
      await sqlState(
        asWriter([line(id, 3, ownerBook, '1100', 7), line(id, 4, ownerBook, '4000', -7)]),
      ),
    ).toBe('RA048');
  });

  it('refuses lines in a locked month of their book', async () => {
    await inContext(app, { companyId }, () =>
      app.query(
        "insert into period_lock (company_id, book_id, month, source) values ($1, $2, date_trunc('month', current_date)::date, 'manual')",
        [companyId, ownerBook],
      ),
    );
    const id = randomUUID();
    expect(
      await sqlState(
        asWriter([
          entry(id, `l:${id}`),
          line(id, 1, ownerBook, '1100', 10),
          line(id, 2, ownerBook, '4000', -10),
        ]),
      ),
    ).toBe('RA044');
    // The next month is open.
    const later = randomUUID();
    await asWriter([
      entry(later, `m:${later}`, "(date_trunc('month', current_date) + interval '1 month')::date"),
      line(later, 1, ownerBook, '1100', 10),
      line(later, 2, ownerBook, '4000', -10),
    ]);
    expect(
      await sqlState(
        inContext(app, { companyId }, () =>
          app.query(`update period_lock set source = 'owner_statement'`),
        ),
      ),
    ).toMatch(/^(42501|RA001)$/);
  });

  it('keeps the chart of accounts read-only', async () => {
    const owner = await connect(db.ownerUrl);
    try {
      expect(
        await sqlState(owner.query("update ledger_account set name = 'x' where code = '1010'")),
      ).toBe('RA001');
    } finally {
      await owner.end();
    }
    const accounts = await runSql<{ n: number }>(
      db.ownerUrl,
      'select count(*)::int as n from ledger_account',
    );
    expect(accounts).toEqual([{ n: 28 }]);
  });
});
