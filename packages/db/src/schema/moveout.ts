import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { payment } from './billing';
import { company } from './company';
import { person } from './identity';
import { book, journalEntry } from './ledger';
import { inspection } from './maintenance';
import { notice } from './notices';
import { approvalRequest, document } from './platform';
import { owner, unit } from './register';
import { lease } from './tenancy';

/**
 * Move-out (TL-11, MI-11; M8 decision 12 and plan 4.8): one flow for every ending, from the
 * planned date to the refund, and the deposit settlement of a lease that ended without one (M8
 * section 9, Backend). Security, triggers and grants are in 0041_maintenance_security.sql. No
 * deposit law value is built in (OQ-59).
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
const leaseRef = () => ({
  propertyId: uuid().notNull(),
  tenantId: uuid().notNull(),
  leaseId: uuid().notNull(),
});

/**
 * A move-out: its kind, date and reason, its inspection, the settlement drafted (charges as asked),
 * the statement as approved, and the refund paid. One live per lease. The lease moves by the
 * service in the same transaction (Ending when planned; Ended or Terminated when approved; back to
 * Active when cancelled); a deposit settlement leaves it as it is.
 */
export const moveOut = pgTable(
  'move_out',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    unitId: uuid().notNull(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    kind: text().notNull().default('move_out'),
    reason: text(),
    plannedDate: day().notNull(),
    /** An early end: before the lease's end date (M5's charges and break credit apply). */
    early: boolean().notNull().default(false),
    noticeId: uuid(),
    note: text(),
    status: text().notNull().default('planned'),
    /** The lease's status before it was planned, restored on a cancel. */
    priorLeaseStatus: text(),
    inspectionId: uuid(),
    moveInInspectionId: uuid(),
    /** Agreed early charges and damage beyond the deposit (P01), as drafted. */
    charges: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    approvalRequestId: uuid(),
    /** The final statement as approved (what the approver decided on). */
    statement: jsonb(),
    approvedOn: day(),
    approvedAt: ts(),
    creditRefundMinor: minor(),
    depositRefundMinor: minor(),
    refundEntryId: uuid(),
    paidOn: day(),
    paidFrom: text(),
    paidReference: text(),
    proofDocumentId: uuid(),
    paidEntryId: uuid(),
    paidBy: uuid().references(() => person.id),
    statementDocumentId: uuid(),
    statementSha256: text(),
    cancelledAt: ts(),
    cancelReason: text(),
    closedAt: ts(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('move_out_company_id_id_key').on(t.companyId, t.id),
    unique('move_out_scope_key').on(t.companyId, t.propertyId, t.id),
    unique('move_out_lease_key').on(t.companyId, t.leaseId, t.id),
    uniqueIndex('move_out_one_live')
      .on(t.companyId, t.leaseId)
      .where(sql`${t.status} <> 'cancelled'`),
    foreignKey({
      name: 'move_out_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'move_out_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'move_out_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'move_out_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'move_out_notice_fk',
      columns: [t.companyId, t.propertyId, t.noticeId],
      foreignColumns: [notice.companyId, notice.propertyId, notice.id],
    }),
    foreignKey({
      name: 'move_out_inspection_fk',
      columns: [t.companyId, t.propertyId, t.leaseId, t.inspectionId],
      foreignColumns: [
        inspection.companyId,
        inspection.propertyId,
        inspection.leaseId,
        inspection.id,
      ],
    }),
    foreignKey({
      name: 'move_out_move_in_fk',
      columns: [t.companyId, t.propertyId, t.moveInInspectionId],
      foreignColumns: [inspection.companyId, inspection.propertyId, inspection.id],
    }),
    foreignKey({
      name: 'move_out_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    foreignKey({
      name: 'move_out_proof_fk',
      columns: [t.companyId, t.proofDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'move_out_statement_fk',
      columns: [t.companyId, t.statementDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'move_out_refund_entry_fk',
      columns: [t.companyId, t.refundEntryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    foreignKey({
      name: 'move_out_paid_entry_fk',
      columns: [t.companyId, t.paidEntryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('move_out_status_idx').on(t.companyId, t.status, t.plannedDate),
    check('move_out_kind_check', sql`${t.kind} in ('move_out', 'deposit_settlement')`),
    check(
      'move_out_reason_check',
      sql`(${t.kind} = 'deposit_settlement') = (${t.reason} is null) and (${t.reason} is null or ${t.reason} in ('end_of_term', 'tenant_notice', 'landlord_notice', 'early_termination'))`,
    ),
    check(
      'move_out_status_check',
      sql`${t.status} in ('planned', 'inspected', 'settlement_drafted', 'awaiting_approval', 'approved', 'refund_paid', 'closed', 'cancelled')`,
    ),
    check(
      'move_out_approved_check',
      sql`(${t.status} in ('approved', 'refund_paid', 'closed')) = (${t.approvedOn} is not null and ${t.statement} is not null)`,
    ),
    check(
      'move_out_awaiting_check',
      sql`${t.status} not in ('awaiting_approval', 'approved', 'refund_paid', 'closed') or ${t.approvalRequestId} is not null`,
    ),
    check(
      'move_out_paid_check',
      sql`(${t.status} = 'refund_paid' or (${t.status} = 'closed' and ${t.paidEntryId} is not null)) = (${t.paidEntryId} is not null)
          and (${t.paidEntryId} is null or (${t.paidOn} is not null and ${t.paidFrom} in ('owner_account', 'agency_account')
               and ${t.paidReference} is not null and ${t.proofDocumentId} is not null))`,
    ),
    check(
      'move_out_cancel_check',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null and ${t.cancelReason} is not null)`,
    ),
    check(
      'move_out_refund_check',
      sql`coalesce(${t.creditRefundMinor}, 0) >= 0 and coalesce(${t.depositRefundMinor}, 0) >= 0`,
    ),
    check(
      'move_out_charges_check',
      sql`jsonb_typeof(${t.charges}) = 'array' and jsonb_array_length(${t.charges}) <= 20`,
    ),
    check(
      'move_out_statement_sha_check',
      sql`${t.statementSha256} is null or ${t.statementSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * A deduction from the deposit (MI-11): its kind, amount and reason, and the move-out inspection
 * items and photos behind it. Append-only; a withdrawal is a new record. Together the live
 * deductions never exceed the deposit held (domain and 0041).
 */
export const depositDeduction = pgTable(
  'deposit_deduction',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    moveOutId: uuid().notNull(),
    kind: text().notNull(),
    amountMinor: minor().notNull(),
    reason: text().notNull(),
    inspectionItemIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    photoIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('deposit_deduction_company_id_id_key').on(t.companyId, t.id),
    unique('deposit_deduction_move_out_key').on(t.companyId, t.moveOutId, t.id),
    foreignKey({
      name: 'deposit_deduction_move_out_fk',
      columns: [t.companyId, t.leaseId, t.moveOutId],
      foreignColumns: [moveOut.companyId, moveOut.leaseId, moveOut.id],
    }),
    foreignKey({
      name: 'deposit_deduction_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    index('deposit_deduction_move_out_idx').on(t.companyId, t.moveOutId),
    check(
      'deposit_deduction_kind_check',
      sql`${t.kind} in ('damage', 'cleaning', 'keys', 'missing_items', 'other')`,
    ),
    check('deposit_deduction_amount_check', sql`${t.amountMinor} > 0`),
    check('deposit_deduction_reason_check', sql`length(${t.reason}) between 3 and 500`),
    check(
      'deposit_deduction_evidence_check',
      sql`cardinality(${t.inspectionItemIds}) <= 50 and cardinality(${t.photoIds}) <= 50`,
    ),
  ],
);

/** A deduction withdrawn while the settlement is drafted (never deleted). Once; append-only. */
export const depositDeductionWithdrawal = pgTable(
  'deposit_deduction_withdrawal',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    moveOutId: uuid().notNull(),
    deductionId: uuid().notNull(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('deposit_deduction_withdrawal_company_id_id_key').on(t.companyId, t.id),
    unique('deposit_deduction_withdrawal_once').on(t.companyId, t.deductionId),
    foreignKey({
      name: 'deposit_deduction_withdrawal_deduction_fk',
      columns: [t.companyId, t.moveOutId, t.deductionId],
      foreignColumns: [depositDeduction.companyId, depositDeduction.moveOutId, depositDeduction.id],
    }),
  ],
);

/**
 * The deposit as the settlement used it, by the payment that paid it (P11, P12): applied to open
 * lines, retained for deductions (4300), or approved for refund (2400). Append-only. The nightly
 * check counts these against 2100 per lease (invariant 4).
 */
export const depositApplication = pgTable(
  'deposit_application',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    moveOutId: uuid().notNull(),
    kind: text().notNull(),
    /** The deposit payment whose share this is; null for a deposit carried before shares were kept. */
    paymentId: uuid(),
    amountMinor: minor().notNull(),
    entryId: uuid().notNull(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('deposit_application_company_id_id_key').on(t.companyId, t.id),
    unique('deposit_application_once')
      .on(t.companyId, t.moveOutId, t.kind, t.paymentId)
      .nullsNotDistinct(),
    foreignKey({
      name: 'deposit_application_move_out_fk',
      columns: [t.companyId, t.leaseId, t.moveOutId],
      foreignColumns: [moveOut.companyId, moveOut.leaseId, moveOut.id],
    }),
    foreignKey({
      name: 'deposit_application_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'deposit_application_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    foreignKey({
      name: 'deposit_application_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('deposit_application_lease_idx').on(t.companyId, t.leaseId),
    check('deposit_application_kind_check', sql`${t.kind} in ('applied', 'retained', 'refund')`),
    check('deposit_application_amount_check', sql`${t.amountMinor} > 0`),
    check('deposit_application_dates_check', sql`${t.accountingDate} >= ${t.valueDate}`),
  ],
);

/**
 * The credit refund's draw on each payment (P13 approved at a move-out: Dr 2010 per payment, Cr
 * 2400), as M5's early_termination_refund_part: each payment's credit is reduced by it.
 */
export const moveOutRefundPart = pgTable(
  'move_out_refund_part',
  {
    id: id(),
    companyId: companyId(),
    moveOutId: uuid().notNull(),
    ...leaseRef(),
    paymentId: uuid().notNull(),
    amountMinor: minor().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('move_out_refund_part_company_id_id_key').on(t.companyId, t.id),
    unique('move_out_refund_part_key').on(t.companyId, t.moveOutId, t.paymentId),
    foreignKey({
      name: 'move_out_refund_part_move_out_fk',
      columns: [t.companyId, t.leaseId, t.moveOutId],
      foreignColumns: [moveOut.companyId, moveOut.leaseId, moveOut.id],
    }),
    foreignKey({
      name: 'move_out_refund_part_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'move_out_refund_part_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    index('move_out_refund_part_payment_idx').on(t.companyId, t.paymentId),
    check('move_out_refund_part_amount_check', sql`${t.amountMinor} > 0`),
  ],
);
