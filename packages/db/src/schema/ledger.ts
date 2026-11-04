import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { company } from './company';
import { person } from './identity';
import { owner, property, unit } from './register';
import { lease, tenant } from './tenancy';

/**
 * The ledger (AC-01; ADR-003; M4a plan 4.2): the chart of accounts, books, the journal and period
 * locks. Security, triggers and grants are in the hand-written migration that follows the
 * generated one: the journal is append-only, only `ledger_writer` inserts into it, and a deferred
 * trigger checks at commit that every entry has two lines or more and sums to zero in each book.
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const day = () => date({ mode: 'string' });
const minor = () => bigint({ mode: 'number' });
const companyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);
const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);

/** The chart of accounts (architecture section 4). Global, seeded from the domain, read-only. */
export const ledgerAccount = pgTable(
  'ledger_account',
  {
    code: text().primaryKey(),
    name: text().notNull(),
    type: text().notNull(),
    /** The kinds of book the account may appear in. */
    books: text().array().notNull(),
  },
  (t) => [
    check(
      'ledger_account_type_check',
      sql`${t.type} in ('asset', 'liability', 'equity', 'income', 'expense')`,
    ),
    check('ledger_account_code_check', sql`${t.code} ~ '^[0-9]{4}$'`),
  ],
);

/**
 * A book: one per owner, made with the owner, and one per company (unmatched receipts in the MVP).
 * Every journal entry sums to zero within each book. The platform book arrives with M10.
 */
export const book = pgTable(
  'book',
  {
    id: id(),
    companyId: companyId(),
    kind: text().notNull(),
    ownerId: uuid(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('book_company_id_id_key').on(t.companyId, t.id),
    uniqueIndex('book_one_per_owner')
      .on(t.companyId, t.ownerId)
      .where(sql`${t.ownerId} is not null`),
    uniqueIndex('book_one_company_book')
      .on(t.companyId)
      .where(sql`${t.kind} = 'company'`),
    foreignKey({
      name: 'book_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    check('book_kind_check', sql`${t.kind} in ('owner', 'company', 'platform')`),
    check('book_owner_check', sql`(${t.kind} = 'owner') = (${t.ownerId} is not null)`),
  ],
);

/**
 * A journal entry: one per business event, keyed so a replay posts nothing new. Append-only; a
 * mistake is corrected by a reversal that names the entry it reverses (once).
 */
export const journalEntry = pgTable(
  'journal_entry',
  {
    id: uuid().primaryKey(),
    companyId: companyId(),
    /** The posting rule, P01 to P33 (architecture section 5). */
    rule: text().notNull(),
    /** `<rule>:<record id>`; accruals `P02:<invoice line id>`. Unique per company. */
    idempotencyKey: text().notNull(),
    /** When it happened. */
    valueDate: day().notNull(),
    /** The period it is reported in: the value date, or the first open day after a lock. */
    accountingDate: day().notNull(),
    /** Server time. */
    postedAt: tsNow(),
    reversesEntryId: uuid(),
    /** The business record the entry belongs to. */
    recordType: text().notNull(),
    recordId: uuid().notNull(),
    /** The person whose action caused it, if a person's. */
    causedBy: uuid().references(() => person.id),
    requestId: text(),
  },
  (t) => [
    unique('journal_entry_company_id_id_key').on(t.companyId, t.id),
    unique('journal_entry_key').on(t.companyId, t.idempotencyKey),
    uniqueIndex('journal_entry_reverses_once')
      .on(t.reversesEntryId)
      .where(sql`${t.reversesEntryId} is not null`),
    foreignKey({
      name: 'journal_entry_reverses_fk',
      columns: [t.companyId, t.reversesEntryId],
      foreignColumns: [t.companyId, t.id],
    }),
    index('journal_entry_record_idx').on(t.companyId, t.recordType, t.recordId),
    index('journal_entry_accounting_idx').on(t.companyId, t.accountingDate),
    check('journal_entry_rule_check', sql`${t.rule} ~ '^P[0-9]{2}$'`),
    check('journal_entry_dates_check', sql`${t.accountingDate} >= ${t.valueDate}`),
  ],
);

/**
 * A journal line: a book, an account, a signed amount (debit positive, credit negative) and its
 * dimensions, which form the sub-ledgers. Append-only. The invoice line and payment dimensions
 * have their foreign keys in the security migration (billing's tables come after the ledger's).
 */
export const journalLine = pgTable(
  'journal_line',
  {
    id: uuid().primaryKey(),
    companyId: companyId(),
    entryId: uuid().notNull(),
    lineNo: smallint().notNull(),
    bookId: uuid().notNull(),
    accountCode: text()
      .notNull()
      .references(() => ledgerAccount.code),
    amountMinor: minor().notNull(),
    currency: char({ length: 3 }).notNull().default('GHS'),
    propertyId: uuid(),
    unitId: uuid(),
    leaseId: uuid(),
    tenantId: uuid(),
    invoiceLineId: uuid(),
    paymentId: uuid(),
    collectorId: uuid().references(() => person.id),
    provider: text(),
    settlementAccountId: uuid(),
    settlementId: uuid(),
  },
  (t) => [
    unique('journal_line_company_id_id_key').on(t.companyId, t.id),
    unique('journal_line_position_key').on(t.companyId, t.entryId, t.lineNo),
    foreignKey({
      name: 'journal_line_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    foreignKey({
      name: 'journal_line_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'journal_line_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    foreignKey({
      name: 'journal_line_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'journal_line_lease_fk',
      columns: [t.companyId, t.leaseId],
      foreignColumns: [lease.companyId, lease.id],
    }),
    foreignKey({
      name: 'journal_line_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    index('journal_line_balance_idx').on(t.companyId, t.bookId, t.accountCode),
    index('journal_line_lease_idx').on(t.companyId, t.leaseId, t.accountCode),
    index('journal_line_invoice_line_idx').on(t.companyId, t.invoiceLineId),
    index('journal_line_payment_idx').on(t.companyId, t.paymentId),
    index('journal_line_collector_idx')
      .on(t.companyId, t.collectorId, t.bookId)
      .where(sql`${t.collectorId} is not null`),
    index('journal_line_property_idx').on(t.companyId, t.propertyId),
    index('journal_line_entry_idx').on(t.companyId, t.entryId),
    check('journal_line_amount_check', sql`${t.amountMinor} <> 0`),
    check('journal_line_currency_check', sql`${t.currency} = 'GHS'`),
    check('journal_line_unit_check', sql`${t.unitId} is null or ${t.propertyId} is not null`),
  ],
);

/**
 * A locked month of a book (AC-04): written when the owner's statement is issued (M9). Anything
 * recorded later keeps its value date but takes an accounting date in the first open month.
 * Append-only.
 */
export const periodLock = pgTable(
  'period_lock',
  {
    id: id(),
    companyId: companyId(),
    bookId: uuid().notNull(),
    /** The first day of the locked month. */
    month: day().notNull(),
    source: text().notNull(),
    note: text(),
    lockedBy: uuid().references(() => person.id),
    lockedAt: tsNow(),
  },
  (t) => [
    unique('period_lock_company_id_id_key').on(t.companyId, t.id),
    unique('period_lock_month_key').on(t.companyId, t.bookId, t.month),
    foreignKey({
      name: 'period_lock_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    check('period_lock_month_check', sql`extract(day from ${t.month}) = 1`),
    check('period_lock_source_check', sql`${t.source} in ('owner_statement', 'manual')`),
  ],
);
