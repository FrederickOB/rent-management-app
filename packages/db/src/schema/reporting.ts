import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { company } from './company';
import { person } from './identity';
import { book, journalEntry } from './ledger';
import { approvalRequest, document, documentRenderRequest } from './platform';
import { owner } from './register';

/**
 * Owner reporting (M9 plan 4.6): fee terms, owner statements and their frozen figures,
 * remittances and owner funding, and the dashboard's daily snapshot and Gate 1 figures. Security,
 * triggers and grants are in 0048_reporting_security.sql.
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });
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
const ownerFk = (t: { companyId: never; ownerId: never }, name: string) =>
  foreignKey({
    name,
    columns: [t.companyId, t.ownerId],
    foreignColumns: [owner.companyId, owner.id],
  });

/**
 * An agency-managed owner's fee terms and who pays GRA (AC-02; decision 1; founder decision,
 * 2026-11-05), one version per change, approved by a second person. Append-only: a change is a
 * new row from its effective date.
 */
export const managementFeeTerms = pgTable(
  'management_fee_terms',
  {
    id: id(),
    companyId: companyId(),
    ownerId: uuid().notNull(),
    kind: text().notNull(),
    rateBps: integer(),
    fixedMinor: minor(),
    graPaidBy: text().notNull(),
    effectiveFrom: day().notNull(),
    approvalRequestId: uuid(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('management_fee_terms_company_id_id_key').on(t.companyId, t.id),
    ownerFk(t as never, 'management_fee_terms_owner_fk'),
    foreignKey({
      name: 'management_fee_terms_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    index('management_fee_terms_owner_idx').on(t.companyId, t.ownerId, t.effectiveFrom),
    check(
      'management_fee_terms_kind_check',
      sql`(${t.kind} = 'none' and ${t.rateBps} is null and ${t.fixedMinor} is null) or (${t.kind} = 'percentage' and ${t.rateBps} between 1 and 10000 and ${t.fixedMinor} is null) or (${t.kind} = 'fixed_per_unit' and ${t.rateBps} is null and ${t.fixedMinor} > 0)`,
    ),
    check('management_fee_terms_gra_check', sql`${t.graPaidBy} in ('agency', 'owner')`),
  ],
);

/**
 * An owner's monthly statement (AC-04; decisions 5 to 7): a draft worked out on each read, then
 * issued, which freezes its figures (`owner_statement_figure`), renders its PDF and locks the
 * month for the owner's book. One per owner and month.
 */
export const ownerStatement = pgTable(
  'owner_statement',
  {
    id: id(),
    companyId: companyId(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    /** `YYYY-MM`, a calendar month in the company's time zone. */
    month: text().notNull(),
    firstDay: day().notNull(),
    lastDay: day().notNull(),
    status: text().notNull().default('draft'),
    templateKey: text().notNull(),
    templateVersion: integer().notNull(),
    generatedAt: ts().notNull(),
    issuedAt: ts(),
    issuedBy: uuid().references(() => person.id),
    renderRequestId: uuid(),
    documentId: uuid(),
    sha256: text(),
    deliveredAt: ts(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('owner_statement_company_id_id_key').on(t.companyId, t.id),
    unique('owner_statement_month_key').on(t.companyId, t.ownerId, t.month),
    ownerFk(t as never, 'owner_statement_owner_fk'),
    foreignKey({
      name: 'owner_statement_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'owner_statement_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'owner_statement_render_fk',
      columns: [t.companyId, t.renderRequestId],
      foreignColumns: [documentRenderRequest.companyId, documentRenderRequest.id],
    }),
    check('owner_statement_month_check', sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('owner_statement_status_check', sql`${t.status} in ('draft', 'issued')`),
    check(
      'owner_statement_issued_check',
      sql`(${t.status} = 'issued') = (${t.issuedAt} is not null)`,
    ),
    check('owner_statement_sha_check', sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** The figures of an issued statement, as issued (`flattenStatementFigures`). Append-only. */
export const ownerStatementFigure = pgTable(
  'owner_statement_figure',
  {
    id: id(),
    companyId: companyId(),
    statementId: uuid().notNull(),
    ownerId: uuid().notNull(),
    key: text().notNull(),
    valueMinor: minor().notNull(),
    position: integer().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('owner_statement_figure_company_id_id_key').on(t.companyId, t.id),
    unique('owner_statement_figure_key').on(t.companyId, t.statementId, t.key),
    foreignKey({
      name: 'owner_statement_figure_statement_fk',
      columns: [t.companyId, t.statementId],
      foreignColumns: [ownerStatement.companyId, ownerStatement.id],
    }),
    ownerFk(t as never, 'owner_statement_figure_owner_fk'),
  ],
);

/**
 * A remittance to the owner (P16: Dr 1010 net, Dr 2300 fees retained, Cr 1070), or fees taken
 * without one (Dr 2300, Cr 1070). A record of a transfer already made, with proof (decision 8).
 * Append-only; a mistake is corrected by a reversal entry.
 */
export const remittance = pgTable(
  'remittance',
  {
    id: id(),
    companyId: companyId(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    kind: text().notNull(),
    paidOn: day().notNull(),
    method: text(),
    reference: text(),
    proofDocumentId: uuid(),
    netMinor: minor().notNull(),
    feesRetainedMinor: minor().notNull(),
    entryId: uuid().notNull(),
    accountingDate: day().notNull(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('remittance_company_id_id_key').on(t.companyId, t.id),
    ownerFk(t as never, 'remittance_owner_fk'),
    foreignKey({
      name: 'remittance_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'remittance_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    foreignKey({
      name: 'remittance_proof_fk',
      columns: [t.companyId, t.proofDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    index('remittance_owner_idx').on(t.companyId, t.ownerId, t.paidOn),
    check('remittance_kind_check', sql`${t.kind} in ('remittance', 'fees_taken')`),
    check(
      'remittance_method_check',
      sql`${t.method} is null or ${t.method} in ('bank', 'momo', 'cheque', 'cash')`,
    ),
    check(
      'remittance_amounts_check',
      sql`${t.feesRetainedMinor} >= 0 and ((${t.kind} = 'remittance' and ${t.netMinor} > 0 and ${t.method} is not null and ${t.proofDocumentId} is not null) or (${t.kind} = 'fees_taken' and ${t.netMinor} = 0 and ${t.feesRetainedMinor} > 0))`,
    ),
  ],
);

/** Money the owner sent the agent for the owner's bills (P30: Dr 1070, Cr 1010). Append-only. */
export const ownerFunding = pgTable(
  'owner_funding',
  {
    id: id(),
    companyId: companyId(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    receivedOn: day().notNull(),
    method: text().notNull(),
    reference: text().notNull(),
    proofDocumentId: uuid().notNull(),
    amountMinor: minor().notNull(),
    entryId: uuid().notNull(),
    accountingDate: day().notNull(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('owner_funding_company_id_id_key').on(t.companyId, t.id),
    ownerFk(t as never, 'owner_funding_owner_fk'),
    foreignKey({
      name: 'owner_funding_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'owner_funding_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    foreignKey({
      name: 'owner_funding_proof_fk',
      columns: [t.companyId, t.proofDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    check('owner_funding_method_check', sql`${t.method} in ('bank', 'momo', 'cheque', 'cash')`),
    check('owner_funding_amount_check', sql`${t.amountMinor} > 0`),
  ],
);

/**
 * The dashboard's daily snapshot per lease (decision 11): what the forward walk gives, so the
 * dashboard never walks 5,000 leases. Derived, rewritten by each rollup of the day; statements
 * never read it.
 */
export const leaseSnapshot = pgTable(
  'lease_snapshot',
  {
    companyId: companyId(),
    snapshotDate: day().notNull(),
    leaseId: uuid().notNull(),
    propertyId: uuid().notNull(),
    unitId: uuid().notNull(),
    ownerId: uuid(),
    leaseStatus: text().notNull(),
    occupying: boolean().notNull(),
    endDate: day().notNull(),
    renewalStatus: text(),
    paidUntil: day(),
    monthsPaidAhead: integer().notNull().default(0),
    arrears0To30Minor: minor().notNull().default(0),
    arrears31To60Minor: minor().notNull().default(0),
    arrears61To90Minor: minor().notNull().default(0),
    arrears90PlusMinor: minor().notNull().default(0),
    unearnedRentMinor: minor().notNull().default(0),
    depositHeldMinor: minor().notNull().default(0),
    rentMinor: minor().notNull().default(0),
    serviceChargeMinor: minor().notNull().default(0),
    computedAt: ts().notNull(),
  },
  (t) => [
    primaryKey({ name: 'lease_snapshot_pkey', columns: [t.companyId, t.snapshotDate, t.leaseId] }),
    index('lease_snapshot_property_idx').on(t.companyId, t.snapshotDate, t.propertyId),
  ],
);

/** A company's Gate 1 figures for a day, with their inputs (decision 10). Derived. */
export const metricDaily = pgTable(
  'metric_daily',
  {
    companyId: companyId(),
    metricDate: day().notNull(),
    month: text().notNull(),
    figures: jsonb().notNull(),
    computedAt: ts().notNull(),
  },
  (t) => [primaryKey({ name: 'metric_daily_pkey', columns: [t.companyId, t.metricDate] })],
);

/** A dashboard export (DA-06): Excel stored at once, PDF through the renderer. */
export const dashboardExport = pgTable(
  'dashboard_export',
  {
    id: id(),
    companyId: companyId(),
    format: text().notNull(),
    filters: jsonb().notNull(),
    status: text().notNull(),
    documentId: uuid(),
    renderRequestId: uuid(),
    requestedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('dashboard_export_company_id_id_key').on(t.companyId, t.id),
    uniqueIndex('dashboard_export_render_key')
      .on(t.companyId, t.renderRequestId)
      .where(sql`${t.renderRequestId} is not null`),
    check('dashboard_export_format_check', sql`${t.format} in ('pdf', 'xlsx')`),
    check('dashboard_export_status_check', sql`${t.status} in ('rendering', 'ready', 'failed')`),
  ],
);

/**
 * Each management fee posted (P14), with the base it was charged on (M9 plan 4.2): what the
 * guard reads (the base already charged on a lease), what a reversal or refund takes back, and
 * what the nightly check compares with rate × base. A take-back is a row of its own with negative
 * amounts. Append-only; written in the same transaction as the fee's journal entry.
 */
export const managementFee = pgTable(
  'management_fee',
  {
    id: id(),
    companyId: companyId(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    propertyId: uuid().notNull(),
    unitId: uuid(),
    leaseId: uuid(),
    paymentId: uuid(),
    /** The entry's idempotency key: `P14:…`, `P21:<payment>:fee`, or a refund's or unwind's. */
    key: text().notNull(),
    source: text().notNull(),
    /** For a take-back: the fee it reverses. */
    reversesFeeId: uuid(),
    rateBps: integer(),
    baseMinor: minor().notNull(),
    feeMinor: minor().notNull(),
    valueDate: day().notNull(),
    entryId: uuid().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('management_fee_company_id_id_key').on(t.companyId, t.id),
    unique('management_fee_key').on(t.companyId, t.key, t.paymentId).nullsNotDistinct(),
    ownerFk(t as never, 'management_fee_owner_fk'),
    foreignKey({
      name: 'management_fee_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    foreignKey({
      name: 'management_fee_reverses_fk',
      columns: [t.companyId, t.reversesFeeId],
      foreignColumns: [t.companyId, t.id],
    }),
    index('management_fee_lease_idx').on(t.companyId, t.leaseId),
    index('management_fee_payment_idx').on(t.companyId, t.paymentId),
    check(
      'management_fee_source_check',
      sql`${t.source} in ('payment', 'deposit', 'withholding', 'credit_draw', 'fixed', 'reversal', 'refund', 'unwind')`,
    ),
    check(
      'management_fee_sign_check',
      sql`(${t.source} in ('reversal', 'refund', 'unwind')) = (${t.feeMinor} < 0) and (${t.reversesFeeId} is not null) = (${t.source} in ('reversal', 'refund', 'unwind'))`,
    ),
  ],
);
