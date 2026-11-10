import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { invoiceLine, payment } from './billing';
import { company } from './company';
import { person } from './identity';
import { journalEntry } from './ledger';
import { approvalRequest } from './platform';
import { owner } from './register';
import { lease } from './tenancy';

/**
 * Pilot onboarding (M11 decisions 2 and 3; P25): the company's cut-over, the workbook batches with
 * their validation reports, and every opening item posted. Security, triggers and grants are in
 * 0068_m11_security.sql; the onboarding service's own checks in 0070_m11_onboarding.sql.
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

/**
 * A company's cut-over date (decision 3): every opening entry is dated it. Set on or before the
 * day it is set; fixed once opening balances are posted (`fixed_at`), after which it never changes.
 */
export const companyOnboarding = pgTable(
  'company_onboarding',
  {
    companyId: uuid()
      .primaryKey()
      .references(() => company.id),
    cutOverDate: day().notNull(),
    setBy: uuid().references(() => person.id),
    setAt: tsNow(),
    fixedAt: ts(),
    updatedAt: tsNow(),
  },
  () => [],
);

/**
 * A tenancies, balances or adjustment workbook (decisions 2 and 3), from upload to commit, as the
 * register import is (PR-08). Balances and adjustments post money, so their commit goes through a
 * second person (`opening_balances`) and posts once approved. `validation_id` is new on every
 * validation run: a commit is keyed on the batch and the validation it was shown.
 */
export const onboardingBatch = pgTable(
  'onboarding_batch',
  {
    id: id(),
    companyId: companyId(),
    kind: text().notNull(),
    status: text().notNull().default('uploaded'),
    uploadIntentId: uuid().notNull(),
    storageKey: text().notNull(),
    fileName: text(),
    fileSha256: text(),
    /** Balances and adjustments: the cut-over the batch was validated against. */
    cutOverDate: day(),
    validationId: uuid(),
    report: jsonb(),
    error: text(),
    approvalRequestId: uuid(),
    createdBy: uuid()
      .notNull()
      .references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    validatedAt: ts(),
    committedAt: ts(),
    postedAt: ts(),
  },
  (t) => [
    unique('onboarding_batch_company_id_id_key').on(t.companyId, t.id),
    unique('onboarding_batch_upload_key').on(t.companyId, t.uploadIntentId),
    foreignKey({
      name: 'onboarding_batch_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    index('onboarding_batch_kind_idx').on(t.companyId, t.kind, t.createdAt),
    check('onboarding_batch_kind_check', sql`${t.kind} in ('tenancies', 'balances', 'adjustment')`),
    check(
      'onboarding_batch_status_check',
      sql`${t.status} in ('uploaded', 'validating', 'validated', 'invalid', 'committing', 'committed', 'awaiting_approval', 'posting', 'posted', 'rejected', 'failed')`,
    ),
    check(
      'onboarding_batch_money_check',
      sql`${t.kind} <> 'tenancies' or (${t.approvalRequestId} is null and ${t.postedAt} is null and ${t.status} not in ('awaiting_approval', 'posting', 'posted', 'rejected'))`,
    ),
    check(
      'onboarding_batch_sha_check',
      sql`${t.fileSha256} is null or ${t.fileSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * Every opening item posted (P25), one row per item key (`P25:<batch>:<item>`), with what it
 * created: the opening invoice line, the opening payment, its journal entry. Append-only: an
 * adjustment is new rows with signed amounts. The preview, the adjustment floor and the first
 * owner statement's opening section read from here and the ledger.
 */
export const onboardingItem = pgTable(
  'onboarding_item',
  {
    id: id(),
    companyId: companyId(),
    batchId: uuid().notNull(),
    itemKey: text().notNull(),
    kind: text().notNull(),
    leaseId: uuid(),
    ownerId: uuid(),
    /** Signed: an adjustment that lowers an item is negative. */
    amountMinor: minor().notNull(),
    /** Arrears: the original due date; rent tax outstanding: when it is due to GRA. */
    dueOn: day(),
    /** Arrears and withholding: the rent period the item belongs to. */
    periodStart: day(),
    invoiceLineId: uuid(),
    paymentId: uuid(),
    entryId: uuid(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('onboarding_item_company_id_id_key').on(t.companyId, t.id),
    unique('onboarding_item_key').on(t.companyId, t.itemKey),
    foreignKey({
      name: 'onboarding_item_batch_fk',
      columns: [t.companyId, t.batchId],
      foreignColumns: [onboardingBatch.companyId, onboardingBatch.id],
    }),
    foreignKey({
      name: 'onboarding_item_lease_fk',
      columns: [t.companyId, t.leaseId],
      foreignColumns: [lease.companyId, lease.id],
    }),
    foreignKey({
      name: 'onboarding_item_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'onboarding_item_line_fk',
      columns: [t.companyId, t.invoiceLineId],
      foreignColumns: [invoiceLine.companyId, invoiceLine.id],
    }),
    foreignKey({
      name: 'onboarding_item_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    foreignKey({
      name: 'onboarding_item_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('onboarding_item_lease_idx').on(t.companyId, t.leaseId),
    index('onboarding_item_owner_idx').on(t.companyId, t.ownerId),
    index('onboarding_item_batch_idx').on(t.companyId, t.batchId),
    check(
      'onboarding_item_kind_check',
      sql`${t.kind} in ('arrears', 'advance', 'deposit', 'withholding', 'agent_cash', 'rent_tax')`,
    ),
    check('onboarding_item_amount_check', sql`${t.amountMinor} <> 0`),
    check(
      'onboarding_item_subject_check',
      sql`(${t.kind} in ('agent_cash', 'rent_tax') and ${t.ownerId} is not null and ${t.leaseId} is null) or (${t.kind} not in ('agent_cash', 'rent_tax') and ${t.leaseId} is not null)`,
    ),
    check('onboarding_item_dates_check', sql`${t.accountingDate} >= ${t.valueDate}`),
    check('onboarding_item_key_check', sql`${t.itemKey} ~ '^P25:[^:]+:.+$'`),
  ],
);

/**
 * The days each staff member was active (M11 decision 4): written at most once a day, on their
 * first request, for Gate 1's weekly active managers.
 */
export const staffActiveDay = pgTable(
  'staff_active_day',
  {
    companyId: companyId(),
    personId: uuid()
      .notNull()
      .references(() => person.id),
    day: day().notNull(),
    firstSeenAt: tsNow(),
  },
  (t) => [
    primaryKey({ name: 'staff_active_day_pkey', columns: [t.companyId, t.personId, t.day] }),
    index('staff_active_day_day_idx').on(t.companyId, t.day),
  ],
);
