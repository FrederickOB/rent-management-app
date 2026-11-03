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
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { invoice, payment, receipt } from './billing';
import { bytea, company } from './company';
import { secureLink } from './esign';
import { person } from './identity';
import { approvalRequest, document } from './platform';
import { owner } from './register';
import { lease } from './tenancy';

/**
 * Provider payments (BC-02 to BC-04, BC-06, BC-09, BC-12; M4b plan 4.2 to 4.13): where rent
 * settles, the payments a pay link starts, the provider's webhooks, its settlements, what
 * reconciliation could not explain, reminders sent and receipts delivered. Security, triggers
 * and grants are in the hand-written migration that follows the generated one.
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

/**
 * A bank account rent settles to (ADR-008; decision 2): an owner's, or the agency's client
 * account. The number is encrypted, blind-indexed and masked. A second person approves it, and
 * it may first receive rent 24 hours later; the owner is told by SMS and email.
 */
export const settlementAccount = pgTable(
  'settlement_account',
  {
    id: id(),
    companyId: companyId(),
    holder: text().notNull(),
    ownerId: uuid(),
    bankCode: text().notNull(),
    bankName: text().notNull(),
    branch: text(),
    /** The name as entered. */
    accountName: text().notNull(),
    /** The name the provider's account check returned, where it can check. */
    accountNameChecked: text(),
    numberEncrypted: bytea().notNull(),
    numberIndex: text().notNull(),
    numberMasked: text().notNull(),
    status: text().notNull().default('awaiting_approval'),
    approvalRequestId: uuid(),
    approvedAt: ts(),
    /** 24 hours after approval, by the server clock. */
    usableFrom: ts(),
    activatedAt: ts(),
    retireRequestId: uuid(),
    retiredAt: ts(),
    retireReason: text(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('settlement_account_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'settlement_account_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'settlement_account_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    foreignKey({
      name: 'settlement_account_retire_fk',
      columns: [t.companyId, t.retireRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    index('settlement_account_owner_idx').on(t.companyId, t.ownerId),
    index('settlement_account_number_idx').on(t.companyId, t.numberIndex),
    check('settlement_account_holder_check', sql`${t.holder} in ('owner', 'agency')`),
    check(
      'settlement_account_owner_check',
      sql`(${t.holder} = 'owner') = (${t.ownerId} is not null)`,
    ),
    check(
      'settlement_account_status_check',
      sql`${t.status} in ('awaiting_approval', 'cooling_off', 'active', 'rejected', 'retired')`,
    ),
    check(
      'settlement_account_usable_check',
      sql`${t.status} in ('awaiting_approval', 'rejected') or (${t.approvedAt} is not null and ${t.usableFrom} is not null)`,
    ),
  ],
);

/** A settlement account set up with one provider (a Paystack subaccount): one per provider. */
export const providerSubaccount = pgTable(
  'provider_subaccount',
  {
    id: id(),
    companyId: companyId(),
    settlementAccountId: uuid().notNull(),
    provider: text().notNull(),
    subaccountCode: text().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('provider_subaccount_company_id_id_key').on(t.companyId, t.id),
    unique('provider_subaccount_account_key').on(t.companyId, t.settlementAccountId, t.provider),
    uniqueIndex('provider_subaccount_code_key').on(t.provider, t.subaccountCode),
    foreignKey({
      name: 'provider_subaccount_account_fk',
      columns: [t.companyId, t.settlementAccountId],
      foreignColumns: [settlementAccount.companyId, settlementAccount.id],
    }),
  ],
);

/**
 * Where an agency-managed owner's rent goes (decision 6): the owner's own account, or the
 * agency's client account, from a date. Append-only: a change is a new row. Fee terms arrive with
 * AC-02 (M9).
 */
export const managementAgreement = pgTable(
  'management_agreement',
  {
    id: id(),
    companyId: companyId(),
    ownerId: uuid().notNull(),
    destination: text().notNull(),
    effectiveFrom: day().notNull(),
    /**
     * The approved request that set it (M4b review: where rent goes is a settlement account change,
     * so every agreement needs a second person). Null only for rows written before that rule.
     */
    approvalRequestId: uuid(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('management_agreement_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'management_agreement_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'management_agreement_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    uniqueIndex('management_agreement_approval_key')
      .on(t.companyId, t.approvalRequestId)
      .where(sql`${t.approvalRequestId} is not null`),
    index('management_agreement_owner_idx').on(t.companyId, t.ownerId, t.effectiveFrom),
    check(
      'management_agreement_destination_check',
      sql`${t.destination} in ('owner_account', 'agency_client_account')`,
    ),
  ],
);

/**
 * A payment a pay link started (plan 4.3): one charge with one provider, keyed by our own
 * reference. A double tap finds the same intent through its submission id. The MoMo number it
 * charged is a MoMo account number, so it is encrypted, blind-indexed and masked.
 */
export const paymentIntent = pgTable(
  'payment_intent',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    tenantId: uuid().notNull(),
    leaseId: uuid().notNull(),
    invoiceId: uuid().notNull(),
    secureLinkId: uuid().notNull(),
    submissionId: text().notNull(),
    amountMinor: minor().notNull(),
    currency: currency(),
    method: text().notNull(),
    momoNetwork: text(),
    payerPhoneEncrypted: bytea(),
    payerPhoneIndex: text(),
    payerPhoneMasked: text(),
    /** Ours, unique everywhere: what the provider calls the transaction's reference. */
    reference: text().notNull(),
    provider: text(),
    providerReference: text(),
    settlementAccountId: uuid().notNull(),
    /**
     * Paid ahead beyond the advance rent limit while the company's policy is `warn` (AR-05; M4b
     * review 15): accepted and flagged for the lease's compliance report. The limit and its rule
     * version are recorded as they stood.
     */
    advanceOverLimit: boolean().notNull().default(false),
    advanceLimitMonths: integer(),
    advanceRuleId: uuid(),
    status: text().notNull().default('initiated'),
    checkoutUrl: text(),
    message: text(),
    failureReason: text(),
    verifiedAmountMinor: minor(),
    paymentId: uuid(),
    lastCheckedAt: ts(),
    confirmedAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('payment_intent_company_id_id_key').on(t.companyId, t.id),
    unique('payment_intent_submission_key').on(t.companyId, t.secureLinkId, t.submissionId),
    uniqueIndex('payment_intent_reference_key').on(t.reference),
    foreignKey({
      name: 'payment_intent_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'payment_intent_invoice_fk',
      columns: [t.companyId, t.invoiceId],
      foreignColumns: [invoice.companyId, invoice.id],
    }),
    foreignKey({
      name: 'payment_intent_link_fk',
      columns: [t.companyId, t.propertyId, t.secureLinkId],
      foreignColumns: [secureLink.companyId, secureLink.propertyId, secureLink.id],
    }),
    foreignKey({
      name: 'payment_intent_account_fk',
      columns: [t.companyId, t.settlementAccountId],
      foreignColumns: [settlementAccount.companyId, settlementAccount.id],
    }),
    foreignKey({
      name: 'payment_intent_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    index('payment_intent_link_idx').on(t.companyId, t.secureLinkId, t.createdAt),
    index('payment_intent_status_idx').on(t.companyId, t.status, t.createdAt),
    index('payment_intent_lease_idx').on(t.companyId, t.leaseId),
    check('payment_intent_amount_check', sql`${t.amountMinor} > 0`),
    check('payment_intent_currency_check', sql`${t.currency} = 'GHS'`),
    check('payment_intent_method_check', sql`${t.method} in ('momo', 'card')`),
    check(
      'payment_intent_momo_check',
      sql`(${t.method} = 'momo') = (${t.momoNetwork} is not null) and (${t.method} = 'momo') = (${t.payerPhoneEncrypted} is not null)`,
    ),
    check(
      'payment_intent_momo_network_check',
      sql`${t.momoNetwork} is null or ${t.momoNetwork} in ('mtn', 'telecel', 'at')`,
    ),
    check(
      'payment_intent_status_check',
      sql`${t.status} in ('initiated', 'pending', 'confirmed', 'failed', 'abandoned')`,
    ),
    check(
      'payment_intent_confirmed_check',
      sql`(${t.status} = 'confirmed') = (${t.paymentId} is not null)`,
    ),
  ],
);

/**
 * Every webhook a provider sends, stored raw before anything else (CLAUDE.md section 8; plan
 * 4.4). Global: the intake does not know the company until processing resolves it through a
 * narrow system function. Unique on provider and event id among signed requests, so a replay is a
 * no-op and a forged request cannot take a genuine event's place. Money is never read from it.
 */
export const webhookInbox = pgTable(
  'webhook_inbox',
  {
    id: id(),
    provider: text().notNull(),
    eventId: text().notNull(),
    eventType: text(),
    reference: text(),
    /**
     * The body as received, for a request with a valid signature. A bad-signature request keeps
     * only its size and hash (M4b review 6): enough to investigate, nothing an attacker chose.
     */
    rawBody: text(),
    bodySha256: text(),
    bodyBytes: integer(),
    /** The signature header only, as received; for a bad signature, the request's address too. */
    headers: jsonb().notNull(),
    signatureValid: boolean().notNull(),
    status: text().notNull(),
    outcome: text(),
    receivedAt: tsNow(),
    publishedAt: ts(),
    processedAt: ts(),
  },
  (t) => [
    uniqueIndex('webhook_inbox_event_key')
      .on(t.provider, t.eventId)
      .where(sql`${t.signatureValid}`),
    index('webhook_inbox_unpublished_idx')
      .on(t.receivedAt)
      .where(sql`${t.publishedAt} is null and ${t.signatureValid}`),
    check(
      'webhook_inbox_status_check',
      sql`${t.status} in ('received', 'rejected', 'processed', 'ignored', 'failed')`,
    ),
    check('webhook_inbox_rejected_check', sql`${t.signatureValid} or ${t.status} = 'rejected'`),
    check('webhook_inbox_body_check', sql`not ${t.signatureValid} or ${t.rawBody} is not null`),
  ],
);

/**
 * A provider's settlement to one settlement account (P22; plan 4.8), with its figures as the
 * provider reported them. The P22 entries (one per book) carry its id on their lines.
 */
export const providerSettlement = pgTable(
  'provider_settlement',
  {
    id: id(),
    companyId: companyId(),
    provider: text().notNull(),
    /** The provider's own id for the settlement. */
    settlementRef: text().notNull(),
    settlementAccountId: uuid().notNull(),
    subaccountCode: text().notNull(),
    currency: currency(),
    grossMinor: minor().notNull(),
    feesMinor: minor().notNull(),
    deductionsMinor: minor().notNull(),
    netMinor: minor().notNull(),
    settledAt: timestamp({ withTimezone: true }).notNull(),
    /**
     * The charges it paid out, as the provider listed them: a payment posted after the settlement
     * was reconciled is settled when it appears (M4b review item 16).
     */
    chargeReferences: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: tsNow(),
  },
  (t) => [
    unique('provider_settlement_company_id_id_key').on(t.companyId, t.id),
    unique('provider_settlement_ref_key').on(t.companyId, t.provider, t.settlementRef),
    foreignKey({
      name: 'provider_settlement_account_fk',
      columns: [t.companyId, t.settlementAccountId],
      foreignColumns: [settlementAccount.companyId, settlementAccount.id],
    }),
    check('provider_settlement_currency_check', sql`${t.currency} = 'GHS'`),
    check(
      'provider_settlement_amounts_check',
      // The net may be below zero: deductions larger than what was paid out (M4b review F6).
      sql`${t.grossMinor} >= 0 and ${t.feesMinor} >= 0 and ${t.deductionsMinor} >= 0`,
    ),
  ],
);

/**
 * What reconciliation, verification or receipt delivery could not explain, for a person
 * (CLAUDE.md section 8; plan 4.8). Its detail is in plain words and never carries a phone number,
 * an email or an account number. Keyed so a rerun records it once.
 */
export const reconciliationException = pgTable(
  'reconciliation_exception',
  {
    id: id(),
    companyId: companyId(),
    kind: text().notNull(),
    provider: text().notNull(),
    reference: text(),
    settlementRef: text(),
    paymentId: uuid(),
    propertyId: uuid(),
    ownerId: uuid(),
    detail: text().notNull(),
    amountMinor: minor(),
    dedupeKey: text().notNull(),
    resolvedAt: ts(),
    resolvedBy: uuid().references(() => person.id),
    resolutionNote: text(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('reconciliation_exception_company_id_id_key').on(t.companyId, t.id),
    unique('reconciliation_exception_key').on(t.companyId, t.dedupeKey),
    foreignKey({
      name: 'reconciliation_exception_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    index('reconciliation_exception_open_idx').on(t.companyId, t.resolvedAt, t.createdAt),
    check(
      'reconciliation_exception_kind_check',
      sql`${t.kind} in ('missing_here', 'missing_at_provider', 'amount_differs', 'not_successful_at_provider', 'settlement_difference', 'verified_amount_differs', 'receipt_late')`,
    ),
    check(
      'reconciliation_exception_resolved_check',
      sql`(${t.resolvedAt} is null) = (${t.resolutionNote} is null)`,
    ),
  ],
);

/** One rent reminder step for one invoice (BC-09; plan 4.7): sent, or skipped as missed. */
export const reminderSent = pgTable(
  'reminder_sent',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    tenantId: uuid().notNull(),
    leaseId: uuid().notNull(),
    invoiceId: uuid().notNull(),
    offsetDays: integer().notNull(),
    status: text().notNull(),
    messageId: uuid(),
    stepDate: day().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('reminder_sent_company_id_id_key').on(t.companyId, t.id),
    unique('reminder_sent_step_key').on(t.companyId, t.invoiceId, t.offsetDays),
    foreignKey({
      name: 'reminder_sent_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'reminder_sent_invoice_fk',
      columns: [t.companyId, t.invoiceId],
      foreignColumns: [invoice.companyId, invoice.id],
    }),
    check('reminder_sent_status_check', sql`${t.status} in ('sent', 'skipped')`),
    check(
      'reminder_sent_message_check',
      sql`(${t.status} = 'sent') = (${t.messageId} is not null)`,
    ),
  ],
);

/**
 * A receipt on its way to the tenant (BC-06; plan 4.6): the message that carries it and the time
 * from the payment's confirmation to the send, with an alert past 60 seconds.
 */
export const receiptDelivery = pgTable(
  'receipt_delivery',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    tenantId: uuid().notNull(),
    leaseId: uuid().notNull(),
    receiptId: uuid().notNull(),
    paymentId: uuid().notNull(),
    messageId: uuid().notNull(),
    /** When the payment was confirmed: the posting's server time. */
    confirmedAt: timestamp({ withTimezone: true }).notNull(),
    status: text().notNull().default('queued'),
    channel: text(),
    sentAt: ts(),
    latencyMs: integer(),
    lateAlerted: boolean().notNull().default(false),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('receipt_delivery_company_id_id_key').on(t.companyId, t.id),
    unique('receipt_delivery_receipt_key').on(t.companyId, t.receiptId),
    foreignKey({
      name: 'receipt_delivery_receipt_fk',
      columns: [t.companyId, t.receiptId],
      foreignColumns: [receipt.companyId, receipt.id],
    }),
    foreignKey({
      name: 'receipt_delivery_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    check(
      'receipt_delivery_status_check',
      sql`${t.status} in ('queued', 'sent', 'not_sent', 'failed')`,
    ),
    check('receipt_delivery_latency_check', sql`${t.latencyMs} is null or ${t.latencyMs} >= 0`),
  ],
);

/**
 * Money that belongs to no lease, refunded to its payer with a second person's approval (P31;
 * plan 4.5): through the provider for a provider payment, or recorded with proof for a transfer.
 * P31 posts once the refund is made.
 */
export const unmatchedRefund = pgTable(
  'unmatched_refund',
  {
    id: id(),
    companyId: companyId(),
    paymentId: uuid().notNull(),
    ownerId: uuid(),
    amountMinor: minor().notNull(),
    reason: text().notNull(),
    proofDocumentId: uuid(),
    approvalRequestId: uuid().notNull(),
    status: text().notNull().default('awaiting_approval'),
    providerRefundRef: text(),
    failureReason: text(),
    entryId: uuid(),
    requestedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('unmatched_refund_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'unmatched_refund_payment_fk',
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payment.companyId, payment.id],
    }),
    foreignKey({
      name: 'unmatched_refund_approval_fk',
      columns: [t.companyId, t.approvalRequestId],
      foreignColumns: [approvalRequest.companyId, approvalRequest.id],
    }),
    foreignKey({
      name: 'unmatched_refund_proof_fk',
      columns: [t.companyId, t.proofDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    uniqueIndex('unmatched_refund_one_live')
      .on(t.companyId, t.paymentId)
      .where(sql`${t.status} in ('awaiting_approval', 'approved', 'sent', 'refunded')`),
    check('unmatched_refund_amount_check', sql`${t.amountMinor} > 0`),
    check(
      'unmatched_refund_status_check',
      // `sent`: the provider accepted the refund and has not finished it (M4b review).
      sql`${t.status} in ('awaiting_approval', 'approved', 'sent', 'refunded', 'failed', 'rejected')`,
    ),
    check(
      'unmatched_refund_posted_check',
      sql`(${t.status} = 'refunded') = (${t.entryId} is not null)`,
    ),
  ],
);
