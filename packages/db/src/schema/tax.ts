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
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { invoiceLine, payment } from './billing';
import { company } from './company';
import { person } from './identity';
import { book, journalEntry } from './ledger';
import { approvalRequest, document, rule } from './platform';
import { owner, unit } from './register';
import { chargePeriod, lease } from './tenancy';

/**
 * Rent tax, withholding and VAT payments (TX-01 to TX-04, TX-08, P17 to P20, P24, P33; M5 plan
 * section 5): the tax on each receipt with the rule versions it used and the periods it is pinned
 * to, tax withheld by corporate tenants with their certificates, GRA payments and the items they
 * settle, VAT paid with returns, and the TX-02 alerts sent. Every row is a fact that never
 * changes, except a certificate's decision (append-only, by trigger). Security, triggers and
 * grants are in the hand-written migration that follows the generated one.
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });
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
const leaseRef = () => ({
  propertyId: uuid().notNull(),
  tenantId: uuid().notNull(),
  leaseId: uuid().notNull(),
});
const PAID_FROM = sql.raw(`('owner_account', 'agency_account')`);

/**
 * A rent tax item (TX-01, P17): one event's tax on a lease. `receipt`: a payment received (base
 * from the forward walk, the rent it newly covers); `carry_over`: credit carried to a renewal and
 * applied to rent (P29); `withholding`: the tax a corporate tenant withheld (P19); `reversal` and
 * `withholding_offset`: corrections of an earlier item, negative (P21 mirrors a payment's tax;
 * withholding replaces tax accrued on the cash). The rules rows used are recorded (TX-08), with
 * snapshots of what the report prints, so a report regenerates identically.
 */
export const rentTaxItem = pgTable(
  'rent_tax_item',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    unitId: uuid().notNull(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    kind: text().notNull(),
    paymentId: uuid(),
    withholdingId: uuid(),
    reversesItemId: uuid(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    /** TX-02: 30 days after the value date by the rule; none on a correction. */
    dueDate: day(),
    baseMinor: minor().notNull(),
    rateBps: integer().notNull(),
    taxMinor: minor().notNull(),
    currency: currency(),
    leaseUse: text().notNull(),
    unitCode: text().notNull(),
    tenantName: text().notNull(),
    receiptNumber: bigint({ mode: 'number' }),
    /** The rate's rule (rent tax, or withholding for a withholding item). */
    rateRuleId: uuid()
      .notNull()
      .references(() => rule.id),
    baseRuleId: uuid().references(() => rule.id),
    roundingRuleId: uuid().references(() => rule.id),
    serviceChargeRuleId: uuid().references(() => rule.id),
    dueRuleId: uuid().references(() => rule.id),
    alertRuleId: uuid().references(() => rule.id),
    entryId: uuid(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('rent_tax_item_company_id_id_key').on(t.companyId, t.id),
    unique('rent_tax_item_lease_key').on(t.companyId, t.leaseId, t.id),
    uniqueIndex('rent_tax_item_one_per_receipt')
      .on(t.companyId, t.paymentId, t.leaseId)
      .where(sql`${t.kind} = 'receipt'`),
    uniqueIndex('rent_tax_item_one_reversal')
      .on(t.companyId, t.reversesItemId)
      .where(sql`${t.kind} = 'reversal'`),
    uniqueIndex('rent_tax_item_one_withholding')
      .on(t.companyId, t.withholdingId)
      .where(sql`${t.kind} = 'withholding'`),
    uniqueIndex('rent_tax_item_one_offset')
      .on(t.companyId, t.withholdingId, t.reversesItemId)
      .where(sql`${t.kind} = 'withholding_offset'`),
    foreignKey({
      name: 'rent_tax_item_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'rent_tax_item_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'rent_tax_item_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'rent_tax_item_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'rent_tax_item_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    foreignKey({
      name: 'rent_tax_item_reverses_fk',
      columns: [t.companyId, t.reversesItemId],
      foreignColumns: [t.companyId, t.id],
    }),
    foreignKey({
      name: 'rent_tax_item_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('rent_tax_item_owner_idx').on(t.companyId, t.ownerId, t.accountingDate),
    index('rent_tax_item_payment_idx').on(t.companyId, t.paymentId),
    index('rent_tax_item_due_idx').on(t.companyId, t.dueDate),
    check(
      'rent_tax_item_kind_check',
      sql`${t.kind} in ('receipt', 'carry_over', 'withholding', 'reversal', 'withholding_offset')`,
    ),
    check('rent_tax_item_use_check', sql`${t.leaseUse} in ('residential', 'commercial')`),
    check('rent_tax_item_currency_check', sql`${t.currency} = 'GHS'`),
    check('rent_tax_item_rate_check', sql`${t.rateBps} >= 0`),
    check(
      'rent_tax_item_sign_check',
      sql`case when ${t.kind} in ('reversal', 'withholding_offset')
            then ${t.taxMinor} <= 0 and ${t.baseMinor} <= 0 and ${t.reversesItemId} is not null and ${t.dueDate} is null
            else ${t.taxMinor} >= 0 and ${t.baseMinor} >= 0 and ${t.reversesItemId} is null and ${t.dueDate} is not null end`,
    ),
    check(
      'rent_tax_item_source_check',
      sql`(${t.kind} in ('withholding', 'withholding_offset')) = (${t.withholdingId} is not null)
          and (${t.kind} not in ('receipt', 'reversal') or ${t.paymentId} is not null)`,
    ),
    check('rent_tax_item_entry_check', sql`(${t.taxMinor} <> 0) = (${t.entryId} is not null)`),
    check('rent_tax_item_dates_check', sql`${t.accountingDate} >= ${t.valueDate}`),
  ],
);

/** An item's tax per charge period it is pinned to, split by largest remainder (signed). */
export const rentTaxItemLine = pgTable(
  'rent_tax_item_line',
  {
    id: id(),
    companyId: companyId(),
    itemId: uuid().notNull(),
    ...leaseRef(),
    chargePeriodId: uuid().notNull(),
    invoiceLineId: uuid(),
    baseMinor: minor().notNull(),
    taxMinor: minor().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('rent_tax_item_line_company_id_id_key').on(t.companyId, t.id),
    unique('rent_tax_item_line_period_key').on(t.companyId, t.itemId, t.chargePeriodId),
    foreignKey({
      name: 'rent_tax_item_line_item_fk',
      columns: [t.companyId, t.leaseId, t.itemId],
      foreignColumns: [rentTaxItem.companyId, rentTaxItem.leaseId, rentTaxItem.id],
    }),
    foreignKey({
      name: 'rent_tax_item_line_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'rent_tax_item_line_period_fk',
      columns: [t.companyId, t.chargePeriodId],
      foreignColumns: [chargePeriod.companyId, chargePeriod.id],
    }),
    foreignKey({
      name: 'rent_tax_item_line_invoice_line_fk',
      columns: [t.companyId, t.leaseId, t.invoiceLineId],
      foreignColumns: [invoiceLine.companyId, invoiceLine.leaseId, invoiceLine.id],
    }),
    index('rent_tax_item_line_lease_idx').on(t.companyId, t.leaseId),
    check('rent_tax_item_line_amount_check', sql`${t.baseMinor} <> 0 or ${t.taxMinor} <> 0`),
  ],
);

/**
 * Tax withheld by a corporate tenant (TX-04, P19): pinned to the lines it was withheld on (its
 * allocation rows, source `withholding`), recorded with a payment or advised later. The rate is
 * the rule's (`withholding_tax.rate.*`, unverified); an amount that differs is shown, not refused.
 */
export const withholding = pgTable(
  'withholding',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    unitId: uuid().notNull(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    /** The payment the tenant paid net with, when known. */
    paymentId: uuid(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    amountMinor: minor().notNull(),
    currency: currency(),
    rateBps: integer().notNull(),
    rateRuleId: uuid()
      .notNull()
      .references(() => rule.id),
    differsFromRate: boolean().notNull(),
    note: text(),
    entryId: uuid().notNull(),
    recordedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('withholding_company_id_id_key').on(t.companyId, t.id),
    unique('withholding_lease_key').on(t.companyId, t.leaseId, t.id),
    foreignKey({
      name: 'withholding_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'withholding_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'withholding_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'withholding_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    foreignKey({
      name: 'withholding_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('withholding_lease_idx').on(t.companyId, t.leaseId),
    check('withholding_amount_check', sql`${t.amountMinor} > 0`),
    check('withholding_currency_check', sql`${t.currency} = 'GHS'`),
    check('withholding_dates_check', sql`${t.accountingDate} >= ${t.valueDate}`),
  ],
);

/**
 * A withholding certificate (TX-04, P20; decision 3): uploaded by a manager and confirmed by a user
 * for the owner (an agency admin when the owner has none), never by its uploader; the database
 * refuses that. Confirming posts P20: the withholding settles the owner's rent tax (2200), or is a
 * tax credit for an owner in the letting business (1160).
 */
export const withholdingCertificate = pgTable(
  'withholding_certificate',
  {
    id: id(),
    companyId: companyId(),
    withholdingId: uuid().notNull(),
    ...leaseRef(),
    ownerId: uuid().notNull(),
    documentId: uuid().notNull(),
    certificateNumber: text(),
    issuedOn: day(),
    amountMinor: minor().notNull(),
    status: text().notNull().default('awaiting_confirmation'),
    uploadedBy: uuid()
      .notNull()
      .references(() => person.id),
    decidedBy: uuid().references(() => person.id),
    decidedAt: ts(),
    rejectReason: text(),
    debitAccount: text(),
    entryId: uuid(),
    valueDate: day(),
    accountingDate: day(),
    /**
     * M5 decision 7 (OQ-29): in a single-user company the uploader confirms through a single-user
     * approval request, after its cooling-off and with TOTP; this names that request.
     */
    selfConfirmRequestId: uuid(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('withholding_certificate_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'withholding_certificate_self_confirm_fk',
      columns: [t.companyId, t.selfConfirmRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    uniqueIndex('withholding_certificate_one_live')
      .on(t.companyId, t.withholdingId)
      .where(sql`${t.status} in ('awaiting_confirmation', 'confirmed')`),
    foreignKey({
      name: 'withholding_certificate_withholding_fk',
      columns: [t.companyId, t.leaseId, t.withholdingId],
      foreignColumns: [withholding.companyId, withholding.leaseId, withholding.id],
    }),
    foreignKey({
      name: 'withholding_certificate_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'withholding_certificate_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'withholding_certificate_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'withholding_certificate_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    check(
      'withholding_certificate_status_check',
      sql`${t.status} in ('awaiting_confirmation', 'confirmed', 'rejected')`,
    ),
    check('withholding_certificate_amount_check', sql`${t.amountMinor} > 0`),
    // Decision 3, in the database: the uploader never confirms (nor rejects) their own
    // certificate, except through a single-user request (decision 7), which the trigger checks.
    check(
      'withholding_certificate_two_people_check',
      sql`${t.decidedBy} is null or ${t.decidedBy} <> ${t.uploadedBy} or ${t.selfConfirmRequestId} is not null`,
    ),
    check(
      'withholding_certificate_decided_check',
      sql`(${t.status} = 'awaiting_confirmation') = (${t.decidedBy} is null)`,
    ),
    check(
      'withholding_certificate_posted_check',
      sql`(${t.status} = 'confirmed') = (${t.entryId} is not null)
          and (${t.status} = 'confirmed') = (${t.debitAccount} is not null)
          and (${t.debitAccount} is null or ${t.debitAccount} in ('2200', '1160'))`,
    ),
  ],
);

/** Withholding whose certificate never came, written off with two-person approval (P24 on 1150). */
export const withholdingWriteOff = pgTable(
  'withholding_write_off',
  {
    id: id(),
    companyId: companyId(),
    withholdingId: uuid().notNull(),
    ...leaseRef(),
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
    unique('withholding_write_off_company_id_id_key').on(t.companyId, t.id),
    unique('withholding_write_off_one').on(t.companyId, t.withholdingId),
    foreignKey({
      name: 'withholding_write_off_withholding_fk',
      columns: [t.companyId, t.leaseId, t.withholdingId],
      foreignColumns: [withholding.companyId, withholding.leaseId, withholding.id],
    }),
    foreignKey({
      name: 'withholding_write_off_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'withholding_write_off_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    foreignKey({
      name: 'withholding_write_off_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    check('withholding_write_off_amount_check', sql`${t.amountMinor} > 0`),
    check('withholding_write_off_dates_check', sql`${t.accountingDate} >= ${t.valueDate}`),
  ],
);

/**
 * Rent tax paid to GRA (TX-03, P18): the date, the amount, GRA's receipt number and file, and the
 * items it settles (gra_payment_item), from the owner's account (1010) or the agency's (1070).
 */
export const graPayment = pgTable(
  'gra_payment',
  {
    id: id(),
    companyId: companyId(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    paidOn: day().notNull(),
    accountingDate: day().notNull(),
    amountMinor: minor().notNull(),
    currency: currency(),
    graReceiptNumber: text().notNull(),
    receiptDocumentId: uuid().notNull(),
    paidFrom: text().notNull(),
    note: text(),
    entryId: uuid().notNull(),
    recordedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('gra_payment_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'gra_payment_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'gra_payment_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'gra_payment_document_fk',
      columns: [t.companyId, t.receiptDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'gra_payment_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('gra_payment_owner_idx').on(t.companyId, t.ownerId, t.accountingDate),
    check('gra_payment_amount_check', sql`${t.amountMinor} > 0`),
    check('gra_payment_currency_check', sql`${t.currency} = 'GHS'`),
    check('gra_payment_from_check', sql`${t.paidFrom} in ${PAID_FROM}`),
    check('gra_payment_dates_check', sql`${t.accountingDate} >= ${t.paidOn}`),
  ],
);

/** What a GRA payment settles of each rent tax item. */
export const graPaymentItem = pgTable(
  'gra_payment_item',
  {
    id: id(),
    companyId: companyId(),
    graPaymentId: uuid().notNull(),
    itemId: uuid().notNull(),
    amountMinor: minor().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('gra_payment_item_company_id_id_key').on(t.companyId, t.id),
    unique('gra_payment_item_key').on(t.companyId, t.graPaymentId, t.itemId),
    foreignKey({
      name: 'gra_payment_item_payment_fk',
      columns: [t.companyId, t.graPaymentId],
      foreignColumns: [graPayment.companyId, graPayment.id],
    }),
    foreignKey({
      name: 'gra_payment_item_item_fk',
      columns: [t.companyId, t.itemId],
      foreignColumns: [rentTaxItem.companyId, rentTaxItem.id],
    }),
    index('gra_payment_item_item_idx').on(t.companyId, t.itemId),
    check('gra_payment_item_amount_check', sql`${t.amountMinor} > 0`),
  ],
);

/** VAT and levies paid to GRA with a return (P33): the return's month and GRA's receipt. */
export const vatPayment = pgTable(
  'vat_payment',
  {
    id: id(),
    companyId: companyId(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    periodMonth: day().notNull(),
    paidOn: day().notNull(),
    accountingDate: day().notNull(),
    amountMinor: minor().notNull(),
    currency: currency(),
    graReceiptNumber: text().notNull(),
    receiptDocumentId: uuid().notNull(),
    paidFrom: text().notNull(),
    note: text(),
    entryId: uuid().notNull(),
    recordedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('vat_payment_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'vat_payment_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'vat_payment_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'vat_payment_document_fk',
      columns: [t.companyId, t.receiptDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'vat_payment_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('vat_payment_owner_idx').on(t.companyId, t.ownerId, t.periodMonth),
    check('vat_payment_amount_check', sql`${t.amountMinor} > 0`),
    check('vat_payment_currency_check', sql`${t.currency} = 'GHS'`),
    check('vat_payment_month_check', sql`extract(day from ${t.periodMonth}) = 1`),
    check('vat_payment_from_check', sql`${t.paidFrom} in ${PAID_FROM}`),
    check('vat_payment_dates_check', sql`${t.accountingDate} >= ${t.paidOn}`),
  ],
);

/** A TX-02 alert raised for an open item, once per item and alert day (21, 28). */
export const rentTaxAlert = pgTable(
  'rent_tax_alert',
  {
    id: id(),
    companyId: companyId(),
    itemId: uuid().notNull(),
    ownerId: uuid().notNull(),
    propertyId: uuid().notNull(),
    alertDay: integer().notNull(),
    alertDate: day().notNull(),
    ruleId: uuid().references(() => rule.id),
    recipients: integer().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('rent_tax_alert_company_id_id_key').on(t.companyId, t.id),
    unique('rent_tax_alert_once').on(t.companyId, t.itemId, t.alertDay),
    foreignKey({
      name: 'rent_tax_alert_item_fk',
      columns: [t.companyId, t.itemId],
      foreignColumns: [rentTaxItem.companyId, rentTaxItem.id],
    }),
    check('rent_tax_alert_day_check', sql`${t.alertDay} >= 0`),
    check('rent_tax_alert_recipients_check', sql`${t.recipients} >= 0`),
  ],
);
