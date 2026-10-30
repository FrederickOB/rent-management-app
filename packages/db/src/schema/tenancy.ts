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
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, company } from './company';
import { person } from './identity';
import { document, rule } from './platform';
import { unit } from './register';

/**
 * Tenancy (M3; docs/plans/M3.md section 4.2): tenants, their contacts, ID checks and consent,
 * lease templates, leases and the rent schedule. Security, triggers and grants are in the
 * hand-written migration that follows the generated one.
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
 * A tenant (TL-01, TL-02, TL-04): one record per company. An individual's record links to a global
 * person by phone (app.ensure_tenant_person), so the tenant app shows every tenancy while each
 * company sees only its own record. ID numbers and TINs are encrypted, blind-indexed and masked.
 */
export const tenant = pgTable(
  'tenant',
  {
    id: id(),
    companyId: companyId(),
    kind: text().notNull(),
    displayName: text().notNull(),
    /** A company tenant's registered name (TL-04). */
    legalName: text(),
    phone: text(),
    whatsappPhone: text(),
    email: text(),
    occupation: text(),
    businessType: text(),
    registrationNumber: text(),
    tinEncrypted: bytea(),
    tinIndex: text(),
    tinMasked: text(),
    idType: text(),
    idNumberEncrypted: bytea(),
    idNumberIndex: text(),
    idNumberMasked: text(),
    /** none, not_started, pending, verified, not_matched; a passport is `recorded` (not verified). */
    idStatus: text().notNull().default('none'),
    idVerifiedAt: ts(),
    personId: uuid().references(() => person.id),
    notes: text(),
    isTestContact: boolean().notNull().default(false),
    createdBy: uuid().references(() => person.id),
    archivedAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('tenant_company_id_id_key').on(t.companyId, t.id),
    index('tenant_name_idx').on(t.companyId, t.displayName),
    index('tenant_phone_idx').on(t.companyId, t.phone),
    index('tenant_id_number_idx').on(t.companyId, t.idNumberIndex),
    index('tenant_tin_idx').on(t.companyId, t.tinIndex),
    index('tenant_person_idx').on(t.personId),
    check('tenant_kind_check', sql`${t.kind} in ('individual', 'company')`),
    check(
      'tenant_id_type_check',
      sql`${t.idType} is null or (${t.idType} in ('ghana_card', 'passport') and ${t.kind} = 'individual')`,
    ),
    check(
      'tenant_id_status_check',
      sql`${t.idStatus} in ('none', 'not_started', 'pending', 'verified', 'not_matched', 'recorded') and (${t.idType} is null) = (${t.idStatus} = 'none')`,
    ),
    check(
      'tenant_id_number_check',
      sql`(${t.idType} is null) = (${t.idNumberEncrypted} is null) and (${t.idNumberEncrypted} is null) = (${t.idNumberIndex} is null) and (${t.idNumberEncrypted} is null) = (${t.idNumberMasked} is null)`,
    ),
    check(
      'tenant_tin_check',
      sql`(${t.tinEncrypted} is null) = (${t.tinIndex} is null) and (${t.tinEncrypted} is null) = (${t.tinMasked} is null) and (${t.tinEncrypted} is null or ${t.kind} = 'company')`,
    ),
    check('tenant_person_check', sql`${t.kind} = 'individual' or ${t.personId} is null`),
    check(
      'tenant_company_fields_check',
      sql`${t.kind} = 'company' or (${t.registrationNumber} is null and ${t.businessType} is null and ${t.legalName} is null)`,
    ),
  ],
);

/** Guarantor, next of kin, employer reference (TL-03), authorised signatories and finance contacts (TL-04). */
export const tenantContact = pgTable(
  'tenant_contact',
  {
    id: id(),
    companyId: companyId(),
    tenantId: uuid().notNull(),
    kind: text().notNull(),
    name: text().notNull(),
    phone: text(),
    email: text(),
    /** How a guarantor or next of kin is related to the tenant. */
    relationship: text(),
    /** An employer's name. */
    organisation: text(),
    /** A job title or a signatory's position. */
    position: text(),
    notes: text(),
    isTestContact: boolean().notNull().default(false),
    archivedAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('tenant_contact_company_id_id_key').on(t.companyId, t.id),
    unique('tenant_contact_tenant_key').on(t.companyId, t.tenantId, t.id),
    foreignKey({
      name: 'tenant_contact_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    index('tenant_contact_tenant_idx').on(t.companyId, t.tenantId),
    check(
      'tenant_contact_kind_check',
      sql`${t.kind} in ('guarantor', 'next_of_kin', 'employer', 'signatory', 'finance')`,
    ),
  ],
);

/**
 * A biometric identity check (TL-02; OQ-22, OQ-39): the provider's check id, status and times.
 * No image, selfie or biometric data is ever stored; the provider keeps the capture.
 */
export const idCheck = pgTable(
  'id_check',
  {
    id: id(),
    companyId: companyId(),
    tenantId: uuid().notNull(),
    idType: text().notNull(),
    provider: text().notNull(),
    providerCheckId: text(),
    /** pending (including a provider failure, which is retried), verified, not_matched, cancelled. */
    status: text().notNull().default('pending'),
    /** The provider's last answer, for staff: pending, failed (provider unavailable) and so on. */
    lastResult: text(),
    polls: integer().notNull().default(0),
    lastPolledAt: ts(),
    checkedAt: ts(),
    completedAt: ts(),
    startedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('id_check_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'id_check_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    index('id_check_tenant_idx').on(t.companyId, t.tenantId, t.createdAt),
    uniqueIndex('id_check_one_open')
      .on(t.companyId, t.tenantId)
      .where(sql`${t.status} = 'pending'`),
    check('id_check_type_check', sql`${t.idType} in ('ghana_card', 'passport')`),
    check(
      'id_check_status_check',
      sql`${t.status} in ('pending', 'verified', 'not_matched', 'cancelled')`,
    ),
  ],
);

/**
 * Consent to messages by channel (CM-09; M3 decision 2). Append-only: one row per grant or
 * withdrawal, with the versioned consent text and its hash. The subject is the tenant, or one of
 * the tenant's contacts.
 */
export const consentEvent = pgTable(
  'consent_event',
  {
    id: id(),
    companyId: companyId(),
    tenantId: uuid().notNull(),
    tenantContactId: uuid(),
    channel: text().notNull(),
    action: text().notNull(),
    textVersion: text().notNull(),
    textSha256: text().notNull(),
    source: text().notNull().default('staff'),
    recordedBy: uuid().references(() => person.id),
    recordedAt: tsNow(),
  },
  (t) => [
    unique('consent_event_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'consent_event_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    foreignKey({
      name: 'consent_event_contact_fk',
      columns: [t.companyId, t.tenantId, t.tenantContactId],
      foreignColumns: [tenantContact.companyId, tenantContact.tenantId, tenantContact.id],
    }),
    index('consent_event_subject_idx').on(
      t.companyId,
      t.tenantId,
      t.tenantContactId,
      t.channel,
      t.recordedAt,
    ),
    check('consent_event_channel_check', sql`${t.channel} in ('sms', 'email', 'whatsapp', 'push')`),
    check('consent_event_action_check', sql`${t.action} in ('grant', 'withdraw')`),
    check(
      'consent_event_source_check',
      sql`${t.source} in ('staff', 'reply', 'stop', 'tenant_app')`,
    ),
    check('consent_event_sha_check', sql`${t.textSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** A lease template (TL-05). Its content lives in immutable versions. */
export const leaseTemplate = pgTable(
  'lease_template',
  {
    id: id(),
    companyId: companyId(),
    name: text().notNull(),
    kind: text().notNull(),
    /** Set on the three starters seeded into each company on first use. */
    starterKind: text(),
    createdBy: uuid().references(() => person.id),
    archivedAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('lease_template_company_id_id_key').on(t.companyId, t.id),
    unique('lease_template_name_key').on(t.companyId, t.name),
    uniqueIndex('lease_template_one_starter')
      .on(t.companyId, t.starterKind)
      .where(sql`${t.starterKind} is not null`),
    check(
      'lease_template_kind_check',
      sql`${t.kind} in ('residential', 'commercial', 'short_fixed_term', 'custom')`,
    ),
    check(
      'lease_template_starter_check',
      sql`${t.starterKind} is null or ${t.starterKind} in ('residential', 'commercial', 'short_fixed_term')`,
    ),
  ],
);

/**
 * A published template version (TL-05). Its content never changes (trigger); the counsel-review
 * columns can be set once, by a company admin with a note (M3 decision 3).
 */
export const leaseTemplateVersion = pgTable(
  'lease_template_version',
  {
    id: id(),
    companyId: companyId(),
    templateId: uuid().notNull(),
    version: integer().notNull(),
    content: jsonb().notNull(),
    contentSha256: text().notNull(),
    changeNote: text(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    counselReviewedAt: ts(),
    counselReviewedBy: uuid().references(() => person.id),
    counselReviewNote: text(),
  },
  (t) => [
    unique('lease_template_version_company_id_id_key').on(t.companyId, t.id),
    unique('lease_template_version_number_key').on(t.companyId, t.templateId, t.version),
    foreignKey({
      name: 'lease_template_version_template_fk',
      columns: [t.companyId, t.templateId],
      foreignColumns: [leaseTemplate.companyId, leaseTemplate.id],
    }),
    check('lease_template_version_number_check', sql`${t.version} >= 1`),
    check('lease_template_version_sha_check', sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'lease_template_version_review_check',
      sql`(${t.counselReviewedAt} is null) = (${t.counselReviewedBy} is null) and (${t.counselReviewedAt} is null) = (${t.counselReviewNote} is null)`,
    ),
  ],
);

/**
 * A lease (TL-06, TL-09, PB-09, TX-05, AR-05). Editable as a draft; once issued, its terms are
 * frozen by trigger and its status changes are checked against the lease machine (M3 plan 4.7).
 * The unit, property and tenant never change: a draft for the wrong unit is cancelled.
 */
export const lease = pgTable(
  'lease',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    unitId: uuid().notNull(),
    tenantId: uuid().notNull(),
    status: text().notNull().default('draft'),
    use: text().notNull(),
    templateVersionId: uuid(),
    startDate: day().notNull(),
    endDate: day().notNull(),
    monthlyRentMinor: minor().notNull(),
    currency: char({ length: 3 }).notNull().default('GHS'),
    rentCycle: text().notNull(),
    initialAdvanceMonths: integer(),
    depositMinor: minor(),
    noticeDays: integer().notNull(),
    breakFromDate: day(),
    breakParty: text(),
    breakNoticeDays: integer(),
    breakCreditUnusedDays: boolean(),
    /** Electronic-service contacts named in the lease (prd-issues 25; OQ-10). */
    servicePhones: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    serviceEmails: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    witnessRequired: boolean().notNull().default(true),
    renewsLeaseId: uuid(),
    // The advance rent check (AR-05; plan 4.12), with the rule version it used.
    advanceMonthsDemanded: integer(),
    advanceRule: text(),
    advanceLimitMonths: integer(),
    advanceExceedsLimit: boolean(),
    advanceRuleId: uuid().references(() => rule.id),
    advancePolicy: text(),
    advanceFlagged: boolean().notNull().default(false),
    advanceCheckedAt: ts(),
    // Signing: by e-signature (TL-07) or recorded from paper (M3 decision 7).
    signedAt: ts(),
    signingMethod: text(),
    signedDocumentId: uuid(),
    // Lifecycle.
    activatedOn: day(),
    holdingOverSince: day(),
    endingReason: text(),
    endingNote: text(),
    endingRecordedAt: ts(),
    moveOutDate: day(),
    endReason: text(),
    endedOn: day(),
    cancelledAt: ts(),
    cancelReason: text(),
    // Trackers (TX-05, OQ-45, OQ-44): deadlines come from the rules table, with the rule used.
    rentControlApplies: boolean(),
    rentControlDeadline: day(),
    rentControlRuleId: uuid().references(() => rule.id),
    rentControlNumber: text(),
    rentControlRegisteredOn: day(),
    stampDeadline: day(),
    stampRuleId: uuid().references(() => rule.id),
    stampedOn: day(),
    stampedDocumentId: uuid(),
    formalRequired: boolean(),
    formalRuleId: uuid().references(() => rule.id),
    formalPractitioner: text(),
    formalWetSignedDocumentId: uuid(),
    formalRegisteredOn: day(),
    formalRegistrationNumber: text(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('lease_company_id_id_key').on(t.companyId, t.id),
    unique('lease_scope_key').on(t.companyId, t.propertyId, t.tenantId, t.id),
    foreignKey({
      name: 'lease_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'lease_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    foreignKey({
      name: 'lease_template_version_fk',
      columns: [t.companyId, t.templateVersionId],
      foreignColumns: [leaseTemplateVersion.companyId, leaseTemplateVersion.id],
    }),
    foreignKey({
      name: 'lease_renews_fk',
      columns: [t.companyId, t.renewsLeaseId],
      foreignColumns: [t.companyId, t.id],
    }),
    foreignKey({
      name: 'lease_signed_document_fk',
      columns: [t.companyId, t.signedDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'lease_stamped_document_fk',
      columns: [t.companyId, t.stampedDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'lease_formal_document_fk',
      columns: [t.companyId, t.formalWetSignedDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    index('lease_unit_idx').on(t.companyId, t.unitId, t.status),
    index('lease_tenant_idx').on(t.companyId, t.tenantId),
    index('lease_property_idx').on(t.companyId, t.propertyId),
    index('lease_status_end_idx').on(t.companyId, t.status, t.endDate),
    uniqueIndex('lease_one_renewal')
      .on(t.companyId, t.renewsLeaseId)
      .where(sql`${t.renewsLeaseId} is not null and ${t.status} <> 'cancelled'`),
    check(
      'lease_status_check',
      sql`${t.status} in ('draft', 'pending_signatures', 'signed', 'active', 'ending', 'holding_over', 'ended', 'terminated', 'cancelled')`,
    ),
    check('lease_use_check', sql`${t.use} in ('residential', 'commercial')`),
    check(
      'lease_cycle_check',
      sql`${t.rentCycle} in ('monthly', 'quarterly', 'six_monthly', 'annual')`,
    ),
    check('lease_dates_check', sql`${t.endDate} > ${t.startDate}`),
    check('lease_rent_check', sql`${t.monthlyRentMinor} > 0`),
    check('lease_deposit_check', sql`${t.depositMinor} is null or ${t.depositMinor} > 0`),
    check('lease_notice_check', sql`${t.noticeDays} between 0 and 3650`),
    check(
      'lease_advance_months_check',
      sql`${t.initialAdvanceMonths} is null or ${t.initialAdvanceMonths} >= 1`,
    ),
    check(
      'lease_break_check',
      sql`(${t.breakFromDate} is null) = (${t.breakParty} is null) and (${t.breakFromDate} is null) = (${t.breakNoticeDays} is null) and (${t.breakFromDate} is null) = (${t.breakCreditUnusedDays} is null) and (${t.breakParty} is null or ${t.breakParty} in ('tenant', 'landlord', 'either'))`,
    ),
    check(
      'lease_advance_rule_check',
      sql`${t.advanceRule} is null or ${t.advanceRule} in ('monthly_or_shorter', 'over_six_months')`,
    ),
    check(
      'lease_advance_policy_check',
      sql`${t.advancePolicy} is null or ${t.advancePolicy} in ('off', 'warn', 'block')`,
    ),
    check(
      'lease_signing_method_check',
      sql`${t.signingMethod} is null or ${t.signingMethod} in ('esign', 'paper')`,
    ),
    check(
      'lease_ending_reason_check',
      sql`${t.endingReason} is null or ${t.endingReason} in ('non_renewal', 'notice')`,
    ),
    check(
      'lease_end_reason_check',
      sql`${t.endReason} is null or ${t.endReason} in ('moved_out', 'renewed', 'superseded')`,
    ),
    check('lease_currency_check', sql`${t.currency} = 'GHS'`),
  ],
);

/** The columns that tie a lease's rows to it, and to its property and tenant for scope. */
const leaseRef = () => ({
  propertyId: uuid().notNull(),
  tenantId: uuid().notNull(),
  leaseId: uuid().notNull(),
});

/**
 * Who signs a lease, in order (TL-07): the tenant or a company tenant's signatories, the
 * landlord's signatory, a guarantor and a witness. Frozen with the lease. For a lease signed on
 * paper, `paperSignedOn` records when each party signed (M3 decision 7).
 */
export const leaseParty = pgTable(
  'lease_party',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    partyRole: text().notNull(),
    name: text().notNull(),
    phone: text(),
    email: text(),
    tenantContactId: uuid(),
    staffPersonId: uuid().references(() => person.id),
    required: boolean().notNull().default(true),
    position: smallint().notNull(),
    paperSignedOn: day(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('lease_party_company_id_id_key').on(t.companyId, t.id),
    unique('lease_party_position_key').on(t.companyId, t.leaseId, t.position),
    foreignKey({
      name: 'lease_party_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'lease_party_contact_fk',
      columns: [t.companyId, t.tenantId, t.tenantContactId],
      foreignColumns: [tenantContact.companyId, tenantContact.tenantId, tenantContact.id],
    }),
    index('lease_party_lease_idx').on(t.companyId, t.leaseId),
    check(
      'lease_party_role_check',
      sql`${t.partyRole} in ('tenant', 'signatory', 'landlord', 'guarantor', 'witness')`,
    ),
    check('lease_party_position_check', sql`${t.position} >= 1`),
  ],
);

/** An escalation step: a new monthly rent from the start of a rent period (TL-06). */
export const rentStep = pgTable(
  'rent_step',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    effectiveFrom: day().notNull(),
    monthlyRentMinor: minor().notNull(),
    currency: char({ length: 3 }).notNull().default('GHS'),
    createdAt: tsNow(),
  },
  (t) => [
    unique('rent_step_company_id_id_key').on(t.companyId, t.id),
    unique('rent_step_date_key').on(t.companyId, t.leaseId, t.effectiveFrom),
    foreignKey({
      name: 'rent_step_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    check('rent_step_rent_check', sql`${t.monthlyRentMinor} > 0`),
    check('rent_step_currency_check', sql`${t.currency} = 'GHS'`),
  ],
);

/** Charges on a lease besides rent: the monthly service charge in M3 (TL-06). */
export const leaseCharge = pgTable(
  'lease_charge',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    chargeType: text().notNull(),
    monthlyAmountMinor: minor().notNull(),
    currency: char({ length: 3 }).notNull().default('GHS'),
    createdAt: tsNow(),
  },
  (t) => [
    unique('lease_charge_company_id_id_key').on(t.companyId, t.id),
    unique('lease_charge_type_key').on(t.companyId, t.leaseId, t.chargeType),
    foreignKey({
      name: 'lease_charge_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    check('lease_charge_type_check', sql`${t.chargeType} in ('service_charge')`),
    check('lease_charge_amount_check', sql`${t.monthlyAmountMinor} > 0`),
    check('lease_charge_currency_check', sql`${t.currency} = 'GHS'`),
  ],
);

/**
 * The rent schedule (TL-06; architecture 3.3): one row per month and charge type, anchored on the
 * lease start, generated when the lease is signed. Append-only; holding over adds a month at a time.
 */
export const chargePeriod = pgTable(
  'charge_period',
  {
    id: id(),
    companyId: companyId(),
    ...leaseRef(),
    sequence: integer().notNull(),
    chargeType: text().notNull(),
    periodStart: day().notNull(),
    periodEnd: day().notNull(),
    amountMinor: minor().notNull(),
    currency: char({ length: 3 }).notNull().default('GHS'),
    prorated: boolean().notNull().default(false),
    source: text().notNull().default('schedule'),
    createdAt: tsNow(),
  },
  (t) => [
    unique('charge_period_company_id_id_key').on(t.companyId, t.id),
    unique('charge_period_sequence_key').on(t.companyId, t.leaseId, t.chargeType, t.sequence),
    foreignKey({
      name: 'charge_period_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    index('charge_period_lease_idx').on(t.companyId, t.leaseId, t.periodStart),
    check('charge_period_type_check', sql`${t.chargeType} in ('rent', 'service_charge')`),
    check('charge_period_dates_check', sql`${t.periodEnd} >= ${t.periodStart}`),
    check('charge_period_amount_check', sql`${t.amountMinor} > 0`),
    check('charge_period_sequence_check', sql`${t.sequence} >= 0`),
    check('charge_period_source_check', sql`${t.source} in ('schedule', 'holding_over')`),
    check('charge_period_currency_check', sql`${t.currency} = 'GHS'`),
  ],
);
