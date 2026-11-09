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
import { document, documentRenderRequest } from './platform';

/**
 * Subscription billing and the platform admin console (M10, docs/plans/M10.md section 4.7).
 *
 * - Platform company tables (decision 1): subscriptions, their events, snapshots, invoices,
 *   payments, allocations, receipts and discount codes belong to the platform company
 *   (`company_id`), each naming the subscriber (`subscriber_company_id`). A subscriber reads its
 *   own rows through a select-only policy on that column; it never writes them.
 * - Platform tables (no company): price lists, subscription terms, WhatsApp rates and stored
 *   alerts. Versioned or append-only; written through narrow functions.
 * - Customer company tables: `support_grant` (decision 13).
 *
 * Security, triggers and grants are in 0058_subscription_security.sql.
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });
const day = () => date({ mode: 'string' });
const minor = () => bigint({ mode: 'number' });
const companyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);
const subscriberCompanyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);
const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);
const MONTH = sql.raw(`'^[0-9]{4}-(0[1-9]|1[0-2])$'`);
const TIERS = sql.raw(`('starter', 'growth', 'portfolio')`);
const BANDS = sql.raw(`('single_room', 'self_contained', 'commercial')`);

// Platform tables -------------------------------------------------------------------------------

/** A tier's price list (PB-03, decision 3), one version per change from its effective date. */
export const priceList = pgTable(
  'price_list',
  {
    id: id(),
    tier: text().notNull(),
    /** Pesewas per billable unit per month, by band (PB-01). */
    rateSingleRoomMinor: minor().notNull(),
    rateSelfContainedMinor: minor().notNull(),
    rateCommercialMinor: minor().notNull(),
    minimumMinor: minor().notNull(),
    annualDiscountBps: integer().notNull(),
    effectiveFrom: day().notNull(),
    /** A placeholder until OQ-37 is answered: the console says so. */
    placeholder: boolean().notNull().default(false),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('price_list_version_key').on(t.tier, t.effectiveFrom),
    check('price_list_tier_check', sql`${t.tier} in ${TIERS}`),
    check(
      'price_list_amounts_check',
      sql`${t.rateSingleRoomMinor} >= 0 and ${t.rateSelfContainedMinor} >= 0 and ${t.rateCommercialMinor} >= 0 and ${t.minimumMinor} >= 0`,
    ),
    check('price_list_discount_check', sql`${t.annualDiscountBps} between 0 and 10000`),
  ],
);

/** Subscription terms (decisions 2, 5, 10, 11 and 12), one version per change. */
export const subscriptionTerms = pgTable(
  'subscription_terms',
  {
    id: id(),
    effectiveFrom: day().notNull(),
    trialDays: integer().notNull(),
    /** Days after an invoice's due date before read-only (OQ-34). */
    graceDays: integer().notNull(),
    /** The read-only switch (OQ-34: on). */
    readOnlyEnabled: boolean().notNull(),
    /** Days from an invoice's issue to its due date. */
    dueDays: integer().notNull(),
    retentionDaysAfterCancel: integer().notNull(),
    /** The platform's VAT registration: off, so invoices carry no VAT (decision 10). */
    vatRegistered: boolean().notNull().default(false),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('subscription_terms_version_key').on(t.effectiveFrom),
    check(
      'subscription_terms_days_check',
      sql`${t.trialDays} >= 0 and ${t.graceDays} >= 0 and ${t.dueDays} >= 0 and ${t.retentionDaysAfterCancel} >= 0`,
    ),
  ],
);

/** WhatsApp cost per message by pricing category: an estimate, never an invoice (decision 15). */
export const whatsappRate = pgTable(
  'whatsapp_rate',
  {
    id: id(),
    category: text().notNull(),
    rateMinor: minor().notNull(),
    effectiveFrom: day().notNull(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('whatsapp_rate_version_key').on(t.category, t.effectiveFrom),
    check(
      'whatsapp_rate_category_check',
      sql`${t.category} in ('utility', 'marketing', 'authentication', 'service', 'referral_conversion')`,
    ),
    check('whatsapp_rate_amount_check', sql`${t.rateMinor} >= 0`),
  ],
);

/** Alerts, stored as well as sent (decision 15). Append-only. Never personal data. */
export const alertEvent = pgTable(
  'alert_event',
  {
    id: id(),
    occurredAt: tsNow(),
    severity: text().notNull(),
    code: text().notNull(),
    message: text().notNull(),
    /** The company it concerns, if any: an id only (a global table has no company_id). */
    subjectCompanyId: uuid(),
    data: jsonb(),
  },
  (t) => [
    index('alert_event_time_idx').on(t.occurredAt),
    check('alert_event_severity_check', sql`${t.severity} in ('info', 'warning', 'critical')`),
  ],
);

/**
 * Billing turned on (M10 review BE-5, founder answer Q1): no subscription is invoiced before a
 * platform admin turns billing on from a date, and every trial that started before then runs from
 * that date. Append-only: the latest row is in force.
 */
export const billingActivation = pgTable(
  'billing_activation',
  {
    id: id(),
    startsOn: day().notNull(),
    turnedOnBy: uuid().references(() => person.id),
    note: text(),
    createdAt: tsNow(),
  },
  (t) => [index('billing_activation_time_idx').on(t.createdAt)],
);

// Platform company tables -----------------------------------------------------------------------

/** A company's subscription (AD-08), one per subscriber. Its status changes only by the engine. */
export const subscription = pgTable(
  'subscription',
  {
    id: id(),
    companyId: companyId(),
    subscriberCompanyId: subscriberCompanyId(),
    tier: text().notNull(),
    status: text().notNull(),
    /** The day the subscription started (the company's creation, decision 5). */
    startedOn: day().notNull(),
    /** The trial's last day; null when there is none. */
    trialEndsOn: day(),
    /** A downgrade waiting for the 1st (decision 6). */
    pendingTier: text(),
    pendingTierFrom: day(),
    /** A scheduled cancellation: the last day of service (decision 12). */
    cancelsOn: day(),
    cancelReason: text(),
    cancelledOn: day(),
    /** After a cancellation: staff keep read-only access until this day. */
    readOnlyUntil: day(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('subscription_company_id_id_key').on(t.companyId, t.id),
    // M10 review BE-4: one live subscription per subscriber; a cancelled one stays, and a platform
    // admin may start a new one for the company (reactivation).
    uniqueIndex('subscription_live_key')
      .on(t.subscriberCompanyId)
      .where(sql`${t.status} <> 'cancelled'`),
    index('subscription_subscriber_idx').on(t.subscriberCompanyId, t.createdAt),
    check('subscription_tier_check', sql`${t.tier} in ${TIERS}`),
    check(
      'subscription_pending_tier_check',
      sql`(${t.pendingTier} is null) = (${t.pendingTierFrom} is null) and (${t.pendingTier} is null or ${t.pendingTier} in ${TIERS})`,
    ),
    check(
      'subscription_status_check',
      sql`${t.status} in ('trialing', 'active', 'past_due', 'read_only', 'cancel_scheduled', 'cancelled')`,
    ),
    check(
      'subscription_cancelled_check',
      sql`(${t.status} = 'cancelled') = (${t.cancelledOn} is not null)`,
    ),
  ],
);

/**
 * The subscription's history (decision 5): every status change, tier change (with the day it takes
 * effect), trial extension, discount, annual term and cancellation. Append-only. The tier history
 * that prices a month is the `tier_changed` events (and `started`) by `effective_on`.
 */
export const subscriptionEvent = pgTable(
  'subscription_event',
  {
    id: id(),
    companyId: companyId(),
    subscriptionId: uuid().notNull(),
    subscriberCompanyId: subscriberCompanyId(),
    kind: text().notNull(),
    statusFrom: text(),
    statusTo: text(),
    tier: text(),
    effectiveOn: day(),
    reason: text(),
    data: jsonb(),
    actorPersonId: uuid().references(() => person.id),
    occurredAt: tsNow(),
  },
  (t) => [
    unique('subscription_event_company_id_id_key').on(t.companyId, t.id),
    index('subscription_event_subscription_idx').on(t.companyId, t.subscriptionId, t.occurredAt),
    foreignKey({
      name: 'subscription_event_subscription_fk',
      columns: [t.companyId, t.subscriptionId],
      foreignColumns: [subscription.companyId, subscription.id],
    }),
    check(
      'subscription_event_kind_check',
      sql`${t.kind} in ('started', 'status_changed', 'tier_changed', 'downgrade_scheduled', 'downgrade_withdrawn', 'trial_extended', 'discount_applied', 'annual_started', 'cancel_scheduled', 'cancel_withdrawn', 'reminder_sent')`,
    ),
    check('subscription_event_tier_check', sql`${t.tier} is null or ${t.tier} in ${TIERS}`),
    check(
      'subscription_event_tier_change_check',
      sql`${t.kind} not in ('started', 'tier_changed') or (${t.tier} is not null and ${t.effectiveOn} is not null)`,
    ),
  ],
);

/** The month's billable units (PB-02, D8), frozen for audit and dispute. Append-only. */
export const billingSnapshot = pgTable(
  'billing_snapshot',
  {
    id: id(),
    companyId: companyId(),
    subscriptionId: uuid().notNull(),
    subscriberCompanyId: subscriberCompanyId(),
    month: text().notNull(),
    singleRoomUnits: integer().notNull(),
    selfContainedUnits: integer().notNull(),
    commercialUnits: integer().notNull(),
    takenAt: tsNow(),
  },
  (t) => [
    unique('billing_snapshot_company_id_id_key').on(t.companyId, t.id),
    unique('billing_snapshot_month_key').on(t.companyId, t.subscriberCompanyId, t.month),
    foreignKey({
      name: 'billing_snapshot_subscription_fk',
      columns: [t.companyId, t.subscriptionId],
      foreignColumns: [subscription.companyId, subscription.id],
    }),
    check('billing_snapshot_month_check', sql`${t.month} ~ ${MONTH}`),
    check(
      'billing_snapshot_counts_check',
      sql`${t.singleRoomUnits} >= 0 and ${t.selfContainedUnits} >= 0 and ${t.commercialUnits} >= 0`,
    ),
  ],
);

/** One billable unit of a snapshot: the subscriber's unit, band, lease and days leased. */
export const billingSnapshotUnit = pgTable(
  'billing_snapshot_unit',
  {
    companyId: companyId(),
    snapshotId: uuid().notNull(),
    /** The subscriber's unit and lease: ids only, no foreign key across companies. */
    unitId: uuid().notNull(),
    unitCode: text().notNull(),
    band: text().notNull(),
    leaseId: uuid().notNull(),
    daysLeased: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.snapshotId, t.unitId] }),
    foreignKey({
      name: 'billing_snapshot_unit_snapshot_fk',
      columns: [t.companyId, t.snapshotId],
      foreignColumns: [billingSnapshot.companyId, billingSnapshot.id],
    }),
    check('billing_snapshot_unit_band_check', sql`${t.band} in ${BANDS}`),
    check('billing_snapshot_unit_days_check', sql`${t.daysLeased} between 1 and 31`),
  ],
);

/** A monthly subscription invoice (PB-07): gap-free `SUB-2026-000001`, billed in arrears. */
export const subscriptionInvoice = pgTable(
  'subscription_invoice',
  {
    id: id(),
    companyId: companyId(),
    subscriptionId: uuid().notNull(),
    subscriberCompanyId: subscriberCompanyId(),
    number: text().notNull(),
    month: text().notNull(),
    snapshotId: uuid().notNull(),
    issuedOn: day().notNull(),
    dueOn: day().notNull(),
    subtotalMinor: minor().notNull(),
    discountMinor: minor().notNull(),
    netMinor: minor().notNull(),
    vatMinor: minor().notNull(),
    totalMinor: minor().notNull(),
    currency: text().notNull().default('GHS'),
    status: text().notNull().default('open'),
    paidAt: ts(),
    /** The versions it was priced with (TX-08: past invoices never change with a new version). */
    priceListIds: uuid().array().notNull(),
    termsId: uuid().notNull(),
    vatRuleId: uuid(),
    /** Whether the VAT rule it read was unverified (decision 10): the console warns. */
    vatUnverified: boolean().notNull().default(false),
    templateKey: text().notNull(),
    templateVersion: integer().notNull(),
    renderRequestId: uuid(),
    documentId: uuid(),
    sha256: text(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('subscription_invoice_company_id_id_key').on(t.companyId, t.id),
    unique('subscription_invoice_number_key').on(t.companyId, t.number),
    unique('subscription_invoice_month_key').on(t.companyId, t.subscriberCompanyId, t.month),
    index('subscription_invoice_subscriber_idx').on(t.companyId, t.subscriberCompanyId, t.status),
    foreignKey({
      name: 'subscription_invoice_subscription_fk',
      columns: [t.companyId, t.subscriptionId],
      foreignColumns: [subscription.companyId, subscription.id],
    }),
    foreignKey({
      name: 'subscription_invoice_snapshot_fk',
      columns: [t.companyId, t.snapshotId],
      foreignColumns: [billingSnapshot.companyId, billingSnapshot.id],
    }),
    foreignKey({
      name: 'subscription_invoice_terms_fk',
      columns: [t.termsId],
      foreignColumns: [subscriptionTerms.id],
    }),
    foreignKey({
      name: 'subscription_invoice_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'subscription_invoice_render_fk',
      columns: [t.companyId, t.renderRequestId],
      foreignColumns: [documentRenderRequest.companyId, documentRenderRequest.id],
    }),
    check('subscription_invoice_month_check', sql`${t.month} ~ ${MONTH}`),
    check('subscription_invoice_number_check', sql`${t.number} ~ '^SUB-[0-9]{4}-[0-9]{6,}$'`),
    check('subscription_invoice_status_check', sql`${t.status} in ('open', 'paid', 'void')`),
    check(
      'subscription_invoice_paid_check',
      sql`(${t.status} = 'paid') = (${t.paidAt} is not null)`,
    ),
    check(
      'subscription_invoice_amounts_check',
      sql`${t.subtotalMinor} >= 0 and ${t.discountMinor} <= 0 and ${t.netMinor} = ${t.subtotalMinor} + ${t.discountMinor} and ${t.netMinor} >= 0 and ${t.vatMinor} >= 0 and ${t.totalMinor} = ${t.netMinor} + ${t.vatMinor}`,
    ),
    check('subscription_invoice_dates_check', sql`${t.dueOn} >= ${t.issuedOn}`),
    check(
      'subscription_invoice_sha_check',
      sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** An invoice's lines, each rounded once (decisions 2, 6, 8 and 10). Append-only. */
export const subscriptionInvoiceLine = pgTable(
  'subscription_invoice_line',
  {
    companyId: companyId(),
    invoiceId: uuid().notNull(),
    lineNo: integer().notNull(),
    kind: text().notNull(),
    description: text().notNull(),
    tier: text(),
    band: text(),
    units: integer(),
    rateMinor: minor(),
    days: integer(),
    daysInMonth: integer(),
    rateBps: integer(),
    amountMinor: minor().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.invoiceId, t.lineNo] }),
    foreignKey({
      name: 'subscription_invoice_line_invoice_fk',
      columns: [t.companyId, t.invoiceId],
      foreignColumns: [subscriptionInvoice.companyId, subscriptionInvoice.id],
    }),
    check(
      'subscription_invoice_line_kind_check',
      sql`${t.kind} in ('units', 'minimum', 'discount', 'vat', 'nhil', 'getfund')`,
    ),
    check('subscription_invoice_line_tier_check', sql`${t.tier} is null or ${t.tier} in ${TIERS}`),
    check('subscription_invoice_line_band_check', sql`${t.band} is null or ${t.band} in ${BANDS}`),
    check(
      'subscription_invoice_line_sign_check',
      sql`(${t.kind} = 'discount' and ${t.amountMinor} < 0) or (${t.kind} <> 'discount' and ${t.amountMinor} > 0)`,
    ),
  ],
);

/**
 * A subscription payment (PB-07, decision 9): the platform's own Paystack account, reference
 * `SUB-…`. Open invoices, or 12 months up front (decision 7). Money is recorded once the provider
 * verifies it; the status and provider fields change, never the amount.
 */
export const subscriptionPayment = pgTable(
  'subscription_payment',
  {
    id: id(),
    companyId: companyId(),
    subscriptionId: uuid().notNull(),
    subscriberCompanyId: subscriberCompanyId(),
    reference: text().notNull(),
    purpose: text().notNull(),
    channel: text().notNull(),
    amountMinor: minor().notNull(),
    currency: text().notNull().default('GHS'),
    status: text().notNull().default('initiated'),
    provider: text().notNull(),
    providerReference: text(),
    checkoutUrl: text(),
    /** What the payer sees next, for MoMo (no personal data). */
    message: text(),
    /** For `annual`: the term it buys and the discount it was priced with. */
    annualFirstMonth: text(),
    annualLastMonth: text(),
    annualDiscountBps: integer(),
    /** The client's Idempotency-Key, so a retried request starts no second charge. */
    idempotencyKey: text(),
    initiatedBy: uuid().references(() => person.id),
    succeededAt: ts(),
    failedAt: ts(),
    failureReason: text(),
    reversedAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('subscription_payment_company_id_id_key').on(t.companyId, t.id),
    unique('subscription_payment_reference_key').on(t.companyId, t.reference),
    uniqueIndex('subscription_payment_idempotency_key')
      .on(t.companyId, t.subscriberCompanyId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index('subscription_payment_subscriber_idx').on(t.companyId, t.subscriberCompanyId, t.status),
    foreignKey({
      name: 'subscription_payment_subscription_fk',
      columns: [t.companyId, t.subscriptionId],
      foreignColumns: [subscription.companyId, subscription.id],
    }),
    check('subscription_payment_reference_check', sql`${t.reference} like 'SUB-%'`),
    check('subscription_payment_purpose_check', sql`${t.purpose} in ('invoices', 'annual')`),
    check('subscription_payment_channel_check', sql`${t.channel} in ('card', 'momo')`),
    check(
      'subscription_payment_status_check',
      sql`${t.status} in ('initiated', 'pending', 'succeeded', 'failed', 'reversed')`,
    ),
    check('subscription_payment_amount_check', sql`${t.amountMinor} > 0`),
    check(
      'subscription_payment_annual_check',
      sql`(${t.purpose} = 'annual') = (${t.annualFirstMonth} is not null and ${t.annualLastMonth} is not null and ${t.annualDiscountBps} is not null)`,
    ),
    check(
      'subscription_payment_succeeded_check',
      sql`${t.status} not in ('succeeded', 'reversed') or ${t.succeededAt} is not null`,
    ),
  ],
);

/**
 * Where subscription money went (P26): a payment to an invoice (oldest first), or a monthly draw
 * on prepaid credit (2020) to an invoice (`payment_id` null). Append-only. Prepaid credit is what
 * succeeded payments left unallocated, less the draws.
 */
export const subscriptionAllocation = pgTable(
  'subscription_allocation',
  {
    id: id(),
    companyId: companyId(),
    subscriberCompanyId: subscriberCompanyId(),
    source: text().notNull(),
    paymentId: uuid(),
    invoiceId: uuid().notNull(),
    amountMinor: minor().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('subscription_allocation_company_id_id_key').on(t.companyId, t.id),
    index('subscription_allocation_invoice_idx').on(t.companyId, t.invoiceId),
    index('subscription_allocation_payment_idx').on(t.companyId, t.paymentId),
    foreignKey({
      name: 'subscription_allocation_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [subscriptionPayment.companyId, subscriptionPayment.id],
    }),
    foreignKey({
      name: 'subscription_allocation_invoice_fk',
      columns: [t.companyId, t.invoiceId],
      foreignColumns: [subscriptionInvoice.companyId, subscriptionInvoice.id],
    }),
    check('subscription_allocation_source_check', sql`${t.source} in ('payment', 'prepaid')`),
    check(
      'subscription_allocation_payment_check',
      sql`(${t.source} = 'payment') = (${t.paymentId} is not null)`,
    ),
    check('subscription_allocation_amount_check', sql`${t.amountMinor} > 0`),
  ],
);

/** A receipt for a subscription payment: gap-free `SUBR-2026-000001`. Immutable but for its PDF. */
export const subscriptionReceipt = pgTable(
  'subscription_receipt',
  {
    id: id(),
    companyId: companyId(),
    subscriberCompanyId: subscriberCompanyId(),
    paymentId: uuid().notNull(),
    number: text().notNull(),
    paidOn: day().notNull(),
    amountMinor: minor().notNull(),
    templateKey: text().notNull(),
    templateVersion: integer().notNull(),
    renderRequestId: uuid(),
    documentId: uuid(),
    sha256: text(),
    issuedAt: tsNow(),
  },
  (t) => [
    unique('subscription_receipt_company_id_id_key').on(t.companyId, t.id),
    unique('subscription_receipt_number_key').on(t.companyId, t.number),
    unique('subscription_receipt_payment_key').on(t.companyId, t.paymentId),
    foreignKey({
      name: 'subscription_receipt_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [subscriptionPayment.companyId, subscriptionPayment.id],
    }),
    foreignKey({
      name: 'subscription_receipt_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'subscription_receipt_render_fk',
      columns: [t.companyId, t.renderRequestId],
      foreignColumns: [documentRenderRequest.companyId, documentRenderRequest.id],
    }),
    check('subscription_receipt_number_check', sql`${t.number} ~ '^SUBR-[0-9]{4}-[0-9]{6,}$'`),
    check('subscription_receipt_amount_check', sql`${t.amountMinor} > 0`),
    check(
      'subscription_receipt_sha_check',
      sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * A credit note on a subscription invoice (M10 review BE-6, founder answer Q2): gap-free
 * `SUBC-2026-000001`, in full or in part, never more than the invoice's total less earlier credits.
 * Immutable but for its PDF.
 */
export const subscriptionCreditNote = pgTable(
  'subscription_credit_note',
  {
    id: id(),
    companyId: companyId(),
    subscriberCompanyId: subscriberCompanyId(),
    invoiceId: uuid().notNull(),
    number: text().notNull(),
    issuedOn: day().notNull(),
    netMinor: minor().notNull(),
    vatMinor: minor().notNull(),
    amountMinor: minor().notNull(),
    /** The part beyond what the invoice still owed (a paid invoice): prepaid credit (2020). */
    toCreditMinor: minor().notNull().default(0),
    reason: text().notNull(),
    createdBy: uuid().references(() => person.id),
    templateKey: text().notNull(),
    templateVersion: integer().notNull(),
    renderRequestId: uuid(),
    documentId: uuid(),
    sha256: text(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('subscription_credit_note_company_id_id_key').on(t.companyId, t.id),
    unique('subscription_credit_note_number_key').on(t.companyId, t.number),
    index('subscription_credit_note_invoice_idx').on(t.companyId, t.invoiceId),
    foreignKey({
      name: 'subscription_credit_note_invoice_fk',
      columns: [t.companyId, t.invoiceId],
      foreignColumns: [subscriptionInvoice.companyId, subscriptionInvoice.id],
    }),
    foreignKey({
      name: 'subscription_credit_note_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'subscription_credit_note_render_fk',
      columns: [t.companyId, t.renderRequestId],
      foreignColumns: [documentRenderRequest.companyId, documentRenderRequest.id],
    }),
    check('subscription_credit_note_number_check', sql`${t.number} ~ '^SUBC-[0-9]{4}-[0-9]{6,}$'`),
    check(
      'subscription_credit_note_amounts_check',
      sql`${t.netMinor} >= 0 and ${t.vatMinor} >= 0 and ${t.amountMinor} = ${t.netMinor} + ${t.vatMinor} and ${t.amountMinor} > 0 and ${t.toCreditMinor} between 0 and ${t.amountMinor}`,
    ),
    check(
      'subscription_credit_note_sha_check',
      sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** A discount code (decision 8), defined by a platform admin. Append-only; uses are redemptions. */
export const discountCode = pgTable(
  'discount_code',
  {
    id: id(),
    companyId: companyId(),
    code: text().notNull(),
    kind: text().notNull(),
    percentBps: integer(),
    amountMinor: minor(),
    months: integer().notNull(),
    expiresOn: day(),
    maxUses: integer(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('discount_code_company_id_id_key').on(t.companyId, t.id),
    unique('discount_code_code_key').on(t.companyId, t.code),
    check('discount_code_code_check', sql`${t.code} ~ '^[A-Z0-9-]{2,40}$'`),
    check(
      'discount_code_kind_check',
      sql`(${t.kind} = 'percentage' and ${t.percentBps} between 1 and 10000 and ${t.amountMinor} is null) or (${t.kind} = 'fixed' and ${t.amountMinor} > 0 and ${t.percentBps} is null)`,
    ),
    check('discount_code_months_check', sql`${t.months} >= 1`),
    check('discount_code_max_uses_check', sql`${t.maxUses} is null or ${t.maxUses} >= 1`),
  ],
);

/** A code applied to a subscription, for `months` billing months from `first_month`. Append-only. */
export const discountRedemption = pgTable(
  'discount_redemption',
  {
    id: id(),
    companyId: companyId(),
    discountCodeId: uuid().notNull(),
    subscriptionId: uuid().notNull(),
    subscriberCompanyId: subscriberCompanyId(),
    firstMonth: text().notNull(),
    months: integer().notNull(),
    appliedBy: uuid().references(() => person.id),
    appliedAt: tsNow(),
  },
  (t) => [
    unique('discount_redemption_company_id_id_key').on(t.companyId, t.id),
    unique('discount_redemption_once_key').on(t.companyId, t.discountCodeId, t.subscriptionId),
    foreignKey({
      name: 'discount_redemption_code_fk',
      columns: [t.companyId, t.discountCodeId],
      foreignColumns: [discountCode.companyId, discountCode.id],
    }),
    foreignKey({
      name: 'discount_redemption_subscription_fk',
      columns: [t.companyId, t.subscriptionId],
      foreignColumns: [subscription.companyId, subscription.id],
    }),
    check('discount_redemption_month_check', sql`${t.firstMonth} ~ ${MONTH}`),
    check('discount_redemption_months_check', sql`${t.months} >= 1`),
  ],
);

/** A data export after a cancellation or on request (decision 12): an Excel workbook. */
export const subscriptionExport = pgTable(
  'subscription_export',
  {
    id: id(),
    /** The subscriber's own company: the workbook holds its data. */
    companyId: companyId(),
    status: text().notNull().default('preparing'),
    documentId: uuid(),
    requestedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('subscription_export_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'subscription_export_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    check('subscription_export_status_check', sql`${t.status} in ('preparing', 'ready', 'failed')`),
    check(
      'subscription_export_ready_check',
      sql`(${t.status} = 'ready') = (${t.documentId} is not null)`,
    ),
  ],
);

// Customer company tables -----------------------------------------------------------------------

/**
 * Support access a company admin granted (AD-10, decision 13): for a reason and a period,
 * revocable. Append-only but for the revocation, recorded once. While one is active, a platform
 * admin may open the company read-only; the database checks it in `app.current_company_id()`.
 */
export const supportGrant = pgTable(
  'support_grant',
  {
    id: id(),
    companyId: companyId(),
    grantedBy: uuid()
      .notNull()
      .references(() => person.id),
    reason: text().notNull(),
    startsAt: tsNow(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: ts(),
    revokedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('support_grant_company_id_id_key').on(t.companyId, t.id),
    index('support_grant_active_idx').on(t.companyId, t.endsAt),
    check(
      'support_grant_period_check',
      sql`${t.endsAt} > ${t.startsAt} and ${t.endsAt} <= ${t.startsAt} + interval '7 days'`,
    ),
    check('support_grant_revoked_check', sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`),
  ],
);
