import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { company } from './company';
import { person } from './identity';
import { book, journalEntry } from './ledger';
import { approvalRequest, document, documentRenderRequest, rule } from './platform';
import { owner, unit } from './register';
import { chargePeriod, lease } from './tenancy';

/**
 * Billing (BC-01, BC-05, BC-07, BC-08, BC-11, AR-01 to AR-03, CT-04; M4a plan 4.4 to 4.16):
 * invoices and their lines, accruals, allocations, payments and receipts, cash records, direct
 * receipts, cash banked, corrections, carry-overs, payment references, the per-company counters
 * and stored idempotent requests. Every row is a fact that never changes (append-only, by
 * trigger); balances and statuses are derived. Security, triggers and grants are in the
 * hand-written migration that follows the generated one.
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const day = () => date({ mode: 'string' });
const minor = () => bigint({ mode: 'number' });
const currency = () => char({ length: 3 }).notNull().default('GHS');
const companyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);
const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);

/** The columns that tie a billing row to its lease, and to the lease's property and tenant for scope. */
const leaseRef = () => ({
  propertyId: uuid().notNull(),
  tenantId: uuid().notNull(),
  leaseId: uuid().notNull(),
});

/** The same, where a row may not know its lease yet (money received before it is matched). */
const optionalLeaseRef = () => ({
  propertyId: uuid(),
  tenantId: uuid(),
  leaseId: uuid(),
});

/**
 * A lease's payment reference (BC-03; prd-issues 15; decision 8): issued when the lease is signed,
 * seven Crockford base32 characters, unique across the platform.
 */
export const paymentReference = pgTable(
  'payment_reference',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    reference: text().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('payment_reference_company_id_id_key').on(t.companyId, t.id),
    unique('payment_reference_lease_key').on(t.companyId, t.leaseId),
    uniqueIndex('payment_reference_unique').on(t.reference),
    foreignKey({
      name: 'payment_reference_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    check('payment_reference_format_check', sql`${t.reference} ~ '^[0-9A-HJKMNP-TV-Z]{7}$'`),
  ],
);

/**
 * An invoice (BC-01; plan 4.4): one billing cycle of a lease, its deposit, or a one-off charge.
 * Immutable once issued; its status is derived from its lines' allocations. The names, TINs
 * (masked) and payment reference are snapshots taken when it was issued (CT-04).
 */
export const invoice = pgTable(
  'invoice',
  {
    id: id(),
    companyId: companyId(),
    /** INV-000123: gap-free per company, from the counter row taken in the issuing transaction. */
    number: bigint({ mode: 'number' }).notNull(),
    kind: text().notNull(),
    ...leaseRef(),
    unitId: uuid().notNull(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    issueDate: day().notNull(),
    dueDate: day().notNull(),
    periodFrom: day(),
    periodTo: day(),
    /** With the lease, a cycle invoice's key: the start of its first billed period. */
    cycleStart: day(),
    holdingOver: boolean().notNull().default(false),
    paymentReference: text().notNull(),
    unitCode: text().notNull(),
    propertyName: text().notNull(),
    billedToName: text().notNull(),
    billedToTin: text(),
    billedFromName: text().notNull(),
    billedFromTin: text(),
    /** VAT on a commercial lease (P32): the rules rows the VAT lines used. */
    vatRuleId: uuid().references(() => rule.id),
    vatServiceRuleId: uuid().references(() => rule.id),
    renderRequestId: uuid(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('invoice_company_id_id_key').on(t.companyId, t.id),
    unique('invoice_lease_key').on(t.companyId, t.leaseId, t.id),
    unique('invoice_number_key').on(t.companyId, t.number),
    uniqueIndex('invoice_one_per_cycle')
      .on(t.companyId, t.leaseId, t.cycleStart)
      .where(sql`${t.kind} = 'cycle'`),
    uniqueIndex('invoice_one_deposit')
      .on(t.companyId, t.leaseId)
      .where(sql`${t.kind} = 'deposit'`),
    foreignKey({
      name: 'invoice_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'invoice_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'invoice_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'invoice_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'invoice_render_fk',
      columns: [t.companyId, t.renderRequestId],
      foreignColumns: [documentRenderRequest.companyId, documentRenderRequest.id],
    }),
    index('invoice_lease_idx').on(t.companyId, t.leaseId),
    index('invoice_due_idx').on(t.companyId, t.dueDate),
    index('invoice_tenant_idx').on(t.companyId, t.tenantId),
    index('invoice_property_idx').on(t.companyId, t.propertyId),
    check('invoice_kind_check', sql`${t.kind} in ('cycle', 'deposit', 'one_off')`),
    check('invoice_number_check', sql`${t.number} >= 1`),
    check(
      'invoice_period_check',
      sql`(${t.periodFrom} is null) = (${t.periodTo} is null) and (${t.periodTo} is null or ${t.periodTo} >= ${t.periodFrom})`,
    ),
    check('invoice_cycle_check', sql`(${t.kind} = 'cycle') = (${t.cycleStart} is not null)`),
  ],
);

/**
 * An invoice line (plan 4.4): rent or service charge for one monthly charge period, a deposit, a
 * one-off charge, or a VAT or levy line charged on the line before it (P32), with the rule it used.
 */
export const invoiceLine = pgTable(
  'invoice_line',
  {
    id: id(),
    companyId: companyId(),
    invoiceId: uuid().notNull(),
    ...leaseRef(),
    position: smallint().notNull(),
    kind: text().notNull(),
    baseLineId: uuid(),
    chargePeriodId: uuid(),
    periodStart: day(),
    periodEnd: day(),
    dueDate: day().notNull(),
    amountMinor: minor().notNull(),
    currency: currency(),
    rateBps: integer(),
    ruleId: uuid().references(() => rule.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('invoice_line_company_id_id_key').on(t.companyId, t.id),
    unique('invoice_line_lease_key').on(t.companyId, t.leaseId, t.id),
    unique('invoice_line_invoice_key').on(t.companyId, t.invoiceId, t.id),
    unique('invoice_line_position_key').on(t.companyId, t.invoiceId, t.position),
    uniqueIndex('invoice_line_one_per_period')
      .on(t.companyId, t.chargePeriodId)
      .where(sql`${t.chargePeriodId} is not null`),
    foreignKey({
      name: 'invoice_line_invoice_fk',
      columns: [t.companyId, t.leaseId, t.invoiceId],
      foreignColumns: [invoice.companyId, invoice.leaseId, invoice.id],
    }),
    foreignKey({
      name: 'invoice_line_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'invoice_line_base_fk',
      columns: [t.companyId, t.invoiceId, t.baseLineId],
      foreignColumns: [t.companyId, t.invoiceId, t.id],
    }),
    foreignKey({
      name: 'invoice_line_period_fk',
      columns: [t.companyId, t.chargePeriodId],
      foreignColumns: [chargePeriod.companyId, chargePeriod.id],
    }),
    index('invoice_line_lease_idx').on(t.companyId, t.leaseId),
    check(
      'invoice_line_kind_check',
      sql`${t.kind} in ('deposit', 'rent', 'service_charge', 'one_off', 'vat', 'nhil', 'getfund')`,
    ),
    check('invoice_line_amount_check', sql`${t.amountMinor} > 0`),
    check('invoice_line_position_check', sql`${t.position} >= 1`),
    check('invoice_line_currency_check', sql`${t.currency} = 'GHS'`),
    check(
      'invoice_line_tax_check',
      sql`(${t.kind} in ('vat', 'nhil', 'getfund')) = (${t.baseLineId} is not null) and (${t.kind} in ('vat', 'nhil', 'getfund')) = (${t.rateBps} is not null)`,
    ),
    check(
      'invoice_line_period_check',
      sql`(${t.kind} in ('rent', 'service_charge')) = (${t.chargePeriodId} is not null) and (${t.chargePeriodId} is null) = (${t.periodStart} is null) and (${t.periodStart} is null) = (${t.periodEnd} is null)`,
    ),
  ],
);

/**
 * A recurring line's accrual (AR-01; plan 4.6): its period has started and P02 has run, or found
 * nothing to post (a line credited to zero). One per line, so a line is never reconsidered.
 */
export const invoiceLineAccrual = pgTable(
  'invoice_line_accrual',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    invoiceLineId: uuid().notNull(),
    /** What became income; zero when the line was credited to nothing first. */
    amountMinor: minor().notNull(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    entryId: uuid(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('invoice_line_accrual_company_id_id_key').on(t.companyId, t.id),
    unique('invoice_line_accrual_line_key').on(t.companyId, t.invoiceLineId),
    foreignKey({
      name: 'invoice_line_accrual_line_fk',
      columns: [t.companyId, t.leaseId, t.invoiceLineId],
      foreignColumns: [invoiceLine.companyId, invoiceLine.leaseId, invoiceLine.id],
    }),
    foreignKey({
      name: 'invoice_line_accrual_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'invoice_line_accrual_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    check('invoice_line_accrual_amount_check', sql`${t.amountMinor} >= 0`),
    check(
      'invoice_line_accrual_entry_check',
      sql`(${t.amountMinor} > 0) = (${t.entryId} is not null)`,
    ),
  ],
);

/**
 * Money received (BC-02 to BC-07): a cash or cheque record once approved (P06), a transfer into
 * the owner's or the agency's account once approved (P28), or the provider test harness (P03,
 * standing in for M4b). Where the money sits is its book and cash account; a payment with no
 * lease waits as unmatched (P23) until a person matches it (payment_match).
 */
export const payment = pgTable(
  'payment',
  {
    id: id(),
    companyId: companyId(),
    method: text().notNull(),
    amountMinor: minor().notNull(),
    currency: currency(),
    /** When the money was received: the value date of its posting. */
    receivedOn: day().notNull(),
    accountingDate: day().notNull(),
    ...optionalLeaseRef(),
    unitId: uuid(),
    /** The owner whose account or book holds it; null for an agency account with no lease yet. */
    ownerId: uuid(),
    bookId: uuid().notNull(),
    cashAccount: text().notNull(),
    collectorPersonId: uuid().references(() => person.id),
    provider: text(),
    payerName: text(),
    senderReference: text(),
    chequeNumber: text(),
    chequeBank: text(),
    note: text(),
    proofDocumentId: uuid(),
    sourceType: text().notNull(),
    sourceId: uuid().notNull(),
    entryId: uuid().notNull(),
    recordedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('payment_company_id_id_key').on(t.companyId, t.id),
    unique('payment_source_key').on(t.companyId, t.sourceType, t.sourceId),
    foreignKey({
      name: 'payment_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'payment_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'payment_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'payment_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'payment_proof_fk',
      columns: [t.companyId, t.proofDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'payment_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('payment_lease_idx').on(t.companyId, t.leaseId),
    index('payment_received_idx').on(t.companyId, t.receivedOn),
    check(
      'payment_method_check',
      sql`${t.method} in ('cash', 'cheque', 'bank_transfer', 'momo', 'card', 'test')`,
    ),
    check('payment_amount_check', sql`${t.amountMinor} > 0`),
    check('payment_currency_check', sql`${t.currency} = 'GHS'`),
    check('payment_cash_account_check', sql`${t.cashAccount} in ('1050', '1060', '1010', '1070')`),
    check(
      'payment_collector_check',
      sql`(${t.cashAccount} = '1060') = (${t.collectorPersonId} is not null)`,
    ),
    check('payment_provider_check', sql`(${t.cashAccount} = '1050') = (${t.provider} is not null)`),
    check(
      'payment_lease_check',
      sql`(${t.leaseId} is null) = (${t.propertyId} is null) and (${t.leaseId} is null) = (${t.tenantId} is null) and (${t.leaseId} is null) = (${t.unitId} is null)`,
    ),
    check(
      'payment_source_type_check',
      sql`${t.sourceType} in ('cash_record', 'direct_receipt', 'provider_test')`,
    ),
    check('payment_dates_check', sql`${t.accountingDate} >= ${t.receivedOn}`),
  ],
);

/** An unmatched payment matched to a lease by a person (P23), which allocates it. */
export const paymentMatch = pgTable(
  'payment_match',
  {
    id: id(),
    companyId: companyId(),
    paymentId: uuid().notNull(),
    ...leaseRef(),
    unitId: uuid().notNull(),
    bookId: uuid().notNull(),
    entryId: uuid().notNull(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    matchedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('payment_match_company_id_id_key').on(t.companyId, t.id),
    unique('payment_match_payment_key').on(t.companyId, t.paymentId),
    foreignKey({
      name: 'payment_match_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    foreignKey({
      name: 'payment_match_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'payment_match_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'payment_match_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('payment_match_lease_idx').on(t.companyId, t.leaseId),
  ],
);

/**
 * A payment reversed (P21b; decision 3): a bounced cheque, a wrong entry or a wrong lease, with a
 * second person's approval. Built from what the payment paid for at the time.
 */
export const paymentReversal = pgTable(
  'payment_reversal',
  {
    id: id(),
    companyId: companyId(),
    paymentId: uuid().notNull(),
    ...optionalLeaseRef(),
    reason: text().notNull(),
    note: text().notNull(),
    moneyNowIn: text().notNull(),
    approvalRequestId: uuid().notNull(),
    entryId: uuid().notNull(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    requestedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('payment_reversal_company_id_id_key').on(t.companyId, t.id),
    unique('payment_reversal_payment_key').on(t.companyId, t.paymentId),
    foreignKey({
      name: 'payment_reversal_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    foreignKey({
      name: 'payment_reversal_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'payment_reversal_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    foreignKey({
      name: 'payment_reversal_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    check(
      'payment_reversal_reason_check',
      sql`${t.reason} in ('bounced_cheque', 'wrong_entry', 'wrong_lease', 'other')`,
    ),
    check(
      'payment_reversal_location_check',
      sql`${t.moneyNowIn} in ('collector', 'owner_account', 'agency_account', 'provider')`,
    ),
  ],
);

/**
 * A receipt (BC-06, numbering half; plan 4.10): one per payment once it is allocated, numbered
 * RC-000123 in the posting transaction, gap-free per company. A reversal adds a credit receipt.
 */
export const receipt = pgTable(
  'receipt',
  {
    id: id(),
    companyId: companyId(),
    number: bigint({ mode: 'number' }).notNull(),
    kind: text().notNull(),
    paymentId: uuid().notNull(),
    reversalId: uuid(),
    ...leaseRef(),
    amountMinor: minor().notNull(),
    issuedAt: tsNow(),
    renderRequestId: uuid(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('receipt_company_id_id_key').on(t.companyId, t.id),
    unique('receipt_number_key').on(t.companyId, t.number),
    unique('receipt_payment_key').on(t.companyId, t.paymentId, t.kind),
    foreignKey({
      name: 'receipt_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    foreignKey({
      name: 'receipt_reversal_fk',
      columns: [t.companyId, t.reversalId],
      foreignColumns: [paymentReversal.companyId, paymentReversal.id],
    }),
    foreignKey({
      name: 'receipt_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'receipt_render_fk',
      columns: [t.companyId, t.renderRequestId],
      foreignColumns: [documentRenderRequest.companyId, documentRenderRequest.id],
    }),
    index('receipt_lease_idx').on(t.companyId, t.leaseId),
    check('receipt_kind_check', sql`${t.kind} in ('receipt', 'credit_receipt')`),
    check('receipt_number_check', sql`${t.number} >= 1`),
    check('receipt_amount_check', sql`${t.amountMinor} > 0`),
    check(
      'receipt_reversal_check',
      sql`(${t.kind} = 'credit_receipt') = (${t.reversalId} is not null)`,
    ),
  ],
);

/**
 * Per-company counters for receipt and invoice numbers (plan 4.10), taken FOR UPDATE in the
 * posting transaction: a failed transaction rolls its number back, so there are no gaps.
 */
export const companyCounter = pgTable(
  'company_counter',
  {
    companyId: companyId(),
    name: text().notNull(),
    value: bigint({ mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.name] }),
    check('company_counter_name_check', sql`${t.name} in ('receipt', 'invoice')`),
    check('company_counter_value_check', sql`${t.value} >= 1`),
  ],
);

/**
 * Cash or a cheque received (BC-05; plan 4.8): who received it, from whom, when, and a photo of
 * the receipt-book page or the cheque. Nothing posts until a second person approves it.
 */
export const cashRecord = pgTable(
  'cash_record',
  {
    id: uuid().primaryKey(),
    companyId: companyId(),
    ...leaseRef(),
    unitId: uuid().notNull(),
    method: text().notNull(),
    amountMinor: minor().notNull(),
    currency: currency(),
    receivedOn: day().notNull(),
    payerName: text().notNull(),
    collectorPersonId: uuid()
      .notNull()
      .references(() => person.id),
    chequeNumber: text(),
    chequeBank: text(),
    photoDocumentId: uuid().notNull(),
    note: text(),
    approvalRequestId: uuid().notNull(),
    recordedBy: uuid()
      .notNull()
      .references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('cash_record_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'cash_record_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'cash_record_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'cash_record_photo_fk',
      columns: [t.companyId, t.photoDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'cash_record_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    index('cash_record_lease_idx').on(t.companyId, t.leaseId),
    index('cash_record_collector_idx').on(t.companyId, t.collectorPersonId),
    check('cash_record_method_check', sql`${t.method} in ('cash', 'cheque')`),
    check('cash_record_amount_check', sql`${t.amountMinor} > 0`),
    check('cash_record_currency_check', sql`${t.currency} = 'GHS'`),
    check(
      'cash_record_cheque_check',
      sql`${t.method} = 'cheque' or (${t.chequeNumber} is null and ${t.chequeBank} is null)`,
    ),
  ],
);

/**
 * A transfer straight into the owner's or the agency's account (P28; plan 4.8), with proof.
 * Without a lease it waits as unmatched (P23). Nothing posts until a second person approves it.
 */
export const directReceipt = pgTable(
  'direct_receipt',
  {
    id: uuid().primaryKey(),
    companyId: companyId(),
    ...optionalLeaseRef(),
    unitId: uuid(),
    receivedInto: text().notNull(),
    ownerId: uuid(),
    amountMinor: minor().notNull(),
    currency: currency(),
    receivedOn: day().notNull(),
    senderReference: text(),
    proofDocumentId: uuid().notNull(),
    note: text(),
    approvalRequestId: uuid().notNull(),
    recordedBy: uuid()
      .notNull()
      .references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('direct_receipt_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'direct_receipt_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'direct_receipt_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'direct_receipt_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'direct_receipt_proof_fk',
      columns: [t.companyId, t.proofDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'direct_receipt_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    check(
      'direct_receipt_into_check',
      sql`${t.receivedInto} in ('owner_account', 'agency_account')`,
    ),
    check(
      'direct_receipt_owner_check',
      sql`${t.receivedInto} <> 'owner_account' or ${t.ownerId} is not null`,
    ),
    check('direct_receipt_amount_check', sql`${t.amountMinor} > 0`),
    check('direct_receipt_currency_check', sql`${t.currency} = 'GHS'`),
    check(
      'direct_receipt_lease_check',
      sql`(${t.leaseId} is null) = (${t.propertyId} is null) and (${t.leaseId} is null) = (${t.tenantId} is null) and (${t.leaseId} is null) = (${t.unitId} is null)`,
    ),
  ],
);

/**
 * A collector's cash banked into the owner's account or handed to the agency (P07; prd-issues
 * 10), with the slip. Never more than the collector holds in that owner's book; a second person
 * approves it.
 */
export const cashBanking = pgTable(
  'cash_banking',
  {
    id: uuid().primaryKey(),
    companyId: companyId(),
    collectorPersonId: uuid()
      .notNull()
      .references(() => person.id),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    bankedInto: text().notNull(),
    amountMinor: minor().notNull(),
    currency: currency(),
    bankedOn: day().notNull(),
    slipDocumentId: uuid().notNull(),
    note: text(),
    approvalRequestId: uuid().notNull(),
    recordedBy: uuid()
      .notNull()
      .references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('cash_banking_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'cash_banking_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'cash_banking_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'cash_banking_slip_fk',
      columns: [t.companyId, t.slipDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'cash_banking_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    index('cash_banking_collector_idx').on(t.companyId, t.collectorPersonId, t.bookId),
    check('cash_banking_into_check', sql`${t.bankedInto} in ('owner_account', 'agency_account')`),
    check('cash_banking_amount_check', sql`${t.amountMinor} > 0`),
    check('cash_banking_currency_check', sql`${t.currency} = 'GHS'`),
  ],
);

/**
 * Balances carried to a renewal (P29; plan 4.11): each payment's credit, keeping its place in the
 * first-in, first-out order, and the deposit held. Debts stay on the old lease.
 */
export const creditCarryOver = pgTable(
  'credit_carry_over',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    fromLeaseId: uuid().notNull(),
    kind: text().notNull(),
    paymentId: uuid(),
    amountMinor: minor().notNull(),
    entryId: uuid().notNull(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('credit_carry_over_company_id_id_key').on(t.companyId, t.id),
    unique('credit_carry_over_once')
      .on(t.companyId, t.leaseId, t.kind, t.paymentId)
      .nullsNotDistinct(),
    foreignKey({
      name: 'credit_carry_over_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'credit_carry_over_from_fk',
      columns: [t.companyId, t.fromLeaseId],
      foreignColumns: [lease.companyId, lease.id],
    }),
    foreignKey({
      name: 'credit_carry_over_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    foreignKey({
      name: 'credit_carry_over_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('credit_carry_over_from_idx').on(t.companyId, t.fromLeaseId),
    check('credit_carry_over_kind_check', sql`${t.kind} in ('credit', 'deposit')`),
    check(
      'credit_carry_over_payment_check',
      sql`(${t.kind} = 'credit') = (${t.paymentId} is not null)`,
    ),
    check('credit_carry_over_amount_check', sql`${t.amountMinor} > 0`),
  ],
);

/**
 * A credit note on a line (P27; plan 4.9): approved by a second person, or a system credit note
 * for the periods after a lease ends (no approval: no income was recognised on them).
 */
export const creditNote = pgTable(
  'credit_note',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    invoiceLineId: uuid().notNull(),
    amountMinor: minor().notNull(),
    reason: text().notNull(),
    kind: text().notNull(),
    approvalRequestId: uuid(),
    entryId: uuid(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('credit_note_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'credit_note_line_fk',
      columns: [t.companyId, t.leaseId, t.invoiceLineId],
      foreignColumns: [invoiceLine.companyId, invoiceLine.leaseId, invoiceLine.id],
    }),
    foreignKey({
      name: 'credit_note_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'credit_note_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    foreignKey({
      name: 'credit_note_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('credit_note_lease_idx').on(t.companyId, t.leaseId),
    check('credit_note_amount_check', sql`${t.amountMinor} > 0`),
    check('credit_note_kind_check', sql`${t.kind} in ('approved', 'system')`),
    check(
      'credit_note_approval_check',
      sql`(${t.kind} = 'approved') = (${t.approvalRequestId} is not null)`,
    ),
  ],
);

/** A write-off of a debt still owed on a charged line (P24), with a second person's approval. */
export const writeOff = pgTable(
  'write_off',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    invoiceLineId: uuid().notNull(),
    amountMinor: minor().notNull(),
    reason: text().notNull(),
    approvalRequestId: uuid().notNull(),
    entryId: uuid().notNull(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('write_off_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'write_off_line_fk',
      columns: [t.companyId, t.leaseId, t.invoiceLineId],
      foreignColumns: [invoiceLine.companyId, invoiceLine.leaseId, invoiceLine.id],
    }),
    foreignKey({
      name: 'write_off_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'write_off_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    foreignKey({
      name: 'write_off_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    check('write_off_amount_check', sql`${t.amountMinor} > 0`),
  ],
);

/**
 * An allocation (BC-07; plan 4.5): money from a payment, deposit, withholding, credit note or
 * write-off applied to one line. Signed: a reversal or a release is a negative row; nothing is
 * ever updated. `record` names the event that wrote it.
 */
export const allocation = pgTable(
  'allocation',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    invoiceLineId: uuid().notNull(),
    source: text().notNull(),
    paymentId: uuid(),
    amountMinor: minor().notNull(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    recordType: text().notNull(),
    recordId: uuid().notNull(),
    entryId: uuid(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('allocation_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'allocation_line_fk',
      columns: [t.companyId, t.leaseId, t.invoiceLineId],
      foreignColumns: [invoiceLine.companyId, invoiceLine.leaseId, invoiceLine.id],
    }),
    foreignKey({
      name: 'allocation_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'allocation_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    foreignKey({
      name: 'allocation_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('allocation_lease_idx').on(t.companyId, t.leaseId),
    index('allocation_line_idx').on(t.companyId, t.invoiceLineId),
    index('allocation_payment_idx').on(t.companyId, t.paymentId),
    check(
      'allocation_source_check',
      sql`${t.source} in ('payment', 'deposit', 'withholding', 'credit_note', 'write_off')`,
    ),
    check('allocation_amount_check', sql`${t.amountMinor} <> 0`),
    check(
      'allocation_payment_check',
      sql`(${t.source} = 'payment') = (${t.paymentId} is not null)`,
    ),
    check(
      'allocation_record_check',
      sql`${t.recordType} in ('payment', 'match', 'accrual', 'reversal', 'credit_note', 'write_off')`,
    ),
    check('allocation_dates_check', sql`${t.accountingDate} >= ${t.valueDate}`),
  ],
);

/**
 * A stored idempotent request (M2 S8; plan 4.15): a retry with the same key and body returns the
 * first response; the same key with another body is refused. The key is reserved when the
 * request arrives, so a duplicate waits for it, and marked written in the same transaction as the
 * write it protects, so the write can never happen twice.
 */
export const idempotentRequest = pgTable(
  'idempotent_request',
  {
    companyId: companyId(),
    key: text().notNull(),
    operation: text().notNull(),
    personId: uuid().references(() => person.id),
    requestHash: text().notNull(),
    /** Set in the write's own transaction: the write happened. */
    writtenAt: timestamp({ withTimezone: true }),
    response: jsonb(),
    createdAt: tsNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'idempotent_request_pkey', columns: [t.companyId, t.key] }),
    check('idempotent_request_hash_check', sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'idempotent_request_done_check',
      sql`(${t.response} is null) = (${t.completedAt} is null)`,
    ),
  ],
);
