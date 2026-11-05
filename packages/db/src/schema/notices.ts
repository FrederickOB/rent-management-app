import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { company, membership } from './company';
import { signer } from './esign';
import { person } from './identity';
import { inspection, maintenanceJob } from './maintenance';
import { document, documentRenderRequest, rule } from './platform';
import { property, unit } from './register';
import { lease, tenant, tenantContact } from './tenancy';

/**
 * Legal notices and staff tasks (LN-01 to LN-09, CF-06; M7 plan 4.9). A notice is a draft until it
 * is issued; once issued, a trigger keeps everything but its status, ladder flags and outcome
 * (0037_notices_security.sql, RA070). Recipients, events, service records, assessments and the
 * OQ-16 acknowledgements are append-only. Tasks change, with every change audited. Every row
 * carries its property, so the scope policies filter it without joins, and no row that staff in
 * scope or a tenant must see has a NULL property.
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });
const day = () => date({ mode: 'string' });
const companyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);
const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const NOTICE_TYPES_SQL = [
  'rent_demand',
  'rent_review',
  'notice_to_quit',
  'entry',
  'breach',
  'non_renewal',
  'building_wide',
  'tenant_originated',
] as const;
const STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'delivered',
  'reminded',
  'opened',
  'escalated',
  'served',
  'signed',
  'closed',
  'cancelled',
  'received',
] as const;
const LIVE = ['sent', 'delivered', 'reminded', 'opened', 'escalated', 'served', 'signed'] as const;
const OUTCOMES = [
  'complied',
  'paid',
  'vacated',
  'disputed',
  'referred_rent_control',
  'referred_court',
  'superseded',
  'withdrawn',
] as const;
/** NOTICE_RECORD_KINDS in packages/domain/notices (a test checks the two agree). */
export const NOTICE_EVENT_KINDS_SQL = [
  'submitted',
  'returned_to_draft',
  'approved',
  'cancelled',
  'sent',
  'delivered',
  'opened',
  'reminded',
  'escalated',
  'served',
  'signed',
  'closed',
  'received',
  'ladder_paused',
  'ladder_resumed',
  'ladder_cancelled',
  'channel_withheld',
  'step_skipped',
  'manager_alerted',
  'task_created',
  'document_ready',
  'service_pack_ready',
  'served_too_late',
  'link_issued',
  'reminder_not_sent',
  'escalation_requested',
] as const;
const CHANNELS = ['whatsapp', 'sms', 'email'] as const;

export const notice = pgTable(
  'notice',
  {
    id: id(),
    companyId: companyId(),
    /** N-000001 once issued: gap-free per company, from company_counter ('notice'). */
    number: integer(),
    type: text().notNull(),
    subtype: text(),
    status: text().notNull().default('draft'),
    propertyId: uuid().notNull(),
    unitId: uuid(),
    leaseId: uuid(),
    tenantId: uuid(),
    /** Building-wide: the blocks chosen, or none for the whole property. */
    blockIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** The type's fields (NOTICE_FIELD_SCHEMAS); frozen at issue. */
    fields: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The built-in template version, and whether counsel had reviewed it (decision 1). */
    templateKey: text().notNull(),
    templateVersion: integer().notNull(),
    counselReviewed: boolean().notNull().default(false),
    /** LN-07: `any_one` for a company tenant's signatories, `each` otherwise. */
    completion: text().notNull().default('each'),
    issueDate: day(),
    issuedAt: ts(),
    effectiveDate: day(),
    earliestLawfulDate: day(),
    /** How the earliest date was reached, and the warnings shown when it was issued. */
    earliest: jsonb(),
    warnings: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Every rule version the calculations read (CLAUDE.md section 7). */
    ruleVersions: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    statutoryRuleId: uuid().references(() => rule.id),
    barRuleId: uuid().references(() => rule.id),
    /** The lease's clause applied and a channel served on it (decisions 4 and 5). */
    electronicService: boolean(),
    /** The ladder's steps as they stood at issue. */
    ladder: jsonb(),
    ladderPaused: boolean().notNull().default(false),
    ladderCancelled: boolean().notNull().default(false),
    ladderReason: text(),
    ladderChangedAt: ts(),
    ladderChangedBy: uuid().references(() => person.id),
    /** M7 review D-B: seconds the ladder spent paused; the remaining steps move by it. */
    ladderShiftSeconds: integer().notNull().default(0),
    /** Every link of the notice expires at this instant (LN-02). */
    linkExpiresAt: ts(),
    renderRequestId: uuid(),
    documentId: uuid(),
    documentSha256: text(),
    servicePackRenderRequestId: uuid(),
    servicePackDocumentId: uuid(),
    correctsNoticeId: uuid(),
    approvalRequestId: uuid(),
    /** Plan 4.3: physical service recorded too late for the stated date. */
    servedTooLate: jsonb(),
    outcome: text(),
    closeNote: text(),
    closedAt: ts(),
    closedBy: uuid().references(() => person.id),
    /** Why the notice last came back to draft (plan 4.3: the date stopped holding at issue). */
    returnedReason: text(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('notice_company_id_id_key').on(t.companyId, t.id),
    unique('notice_scope_key').on(t.companyId, t.propertyId, t.id),
    unique('notice_number_key').on(t.companyId, t.number),
    foreignKey({
      name: 'notice_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    foreignKey({
      name: 'notice_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'notice_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'notice_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    // A correction is for the same property (and, checked by the service, the same lease).
    foreignKey({
      name: 'notice_corrects_fk',
      columns: [t.companyId, t.propertyId, t.correctsNoticeId],
      foreignColumns: [t.companyId, t.propertyId, t.id],
    }),
    foreignKey({
      name: 'notice_render_fk',
      columns: [t.companyId, t.renderRequestId],
      foreignColumns: [documentRenderRequest.companyId, documentRenderRequest.id],
    }),
    foreignKey({
      name: 'notice_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'notice_service_pack_render_fk',
      columns: [t.companyId, t.servicePackRenderRequestId],
      foreignColumns: [documentRenderRequest.companyId, documentRenderRequest.id],
    }),
    foreignKey({
      name: 'notice_service_pack_fk',
      columns: [t.companyId, t.servicePackDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    index('notice_list_idx').on(t.companyId, t.status, t.createdAt),
    index('notice_lease_idx').on(t.companyId, t.leaseId),
    index('notice_tenant_idx').on(t.companyId, t.tenantId),
    index('notice_render_idx').on(t.companyId, t.renderRequestId),
    // M7 review S6: one live correction per notice; a discarded one makes room for another.
    uniqueIndex('notice_one_live_correction_key')
      .on(t.companyId, t.correctsNoticeId)
      .where(sql`${t.correctsNoticeId} is not null and ${t.status} <> 'cancelled'`),
    check('notice_type_check', sql`${t.type} in (${list(NOTICE_TYPES_SQL)})`),
    check('notice_status_check', sql`${t.status} in (${list(STATUSES)})`),
    check(
      'notice_outcome_check',
      sql`(${t.outcome} is null or ${t.outcome} in (${list(OUTCOMES)})) and (${t.status} = 'closed') = (${t.outcome} is not null) and (${t.outcome} is null) = (${t.closedAt} is null)`,
    ),
    check('notice_completion_check', sql`${t.completion} in ('any_one', 'each')`),
    // Building-wide notices go to a property's tenants; every other type is under one lease.
    check(
      'notice_target_check',
      sql`case when ${t.type} = 'building_wide' then ${t.leaseId} is null and ${t.tenantId} is null else ${t.leaseId} is not null and ${t.tenantId} is not null end`,
    ),
    // Numbers exist exactly when a notice has been issued (decision 15).
    check(
      'notice_number_check',
      sql`(${t.number} is null or ${t.number} >= 1) and (${t.status} not in (${list(LIVE)}) or (${t.number} is not null and ${t.issuedAt} is not null and ${t.issueDate} is not null)) and (${t.status} not in ('draft', 'pending_approval', 'approved', 'cancelled', 'received') or ${t.number} is null)`,
    ),
    check(
      'notice_document_sha_check',
      sql`${t.documentSha256} is null or ${t.documentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check('notice_document_check', sql`(${t.documentId} is null) = (${t.documentSha256} is null)`),
  ],
);

/**
 * A recipient (decision 7), snapshotted at issue: a residential tenant, or one authorised
 * signatory of a company tenant. `tenant_id` is the party they acknowledge for, which drives the
 * tenant-scope policies. Append-only.
 */
export const noticeRecipient = pgTable(
  'notice_recipient',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    noticeId: uuid().notNull(),
    tenantId: uuid().notNull(),
    leaseId: uuid(),
    unitId: uuid(),
    kind: text().notNull(),
    tenantContactId: uuid(),
    name: text().notNull(),
    phone: text(),
    whatsappPhone: text(),
    email: text(),
    /** One entry per channel: service, courtesy or withheld, with the reason (decisions 4, 5). */
    channels: jsonb().notNull(),
    physicalServicePlanned: boolean().notNull(),
    signingRequestId: uuid(),
    signerId: uuid(),
    position: smallint().notNull(),
    isTestContact: boolean().notNull().default(false),
    createdAt: tsNow(),
  },
  (t) => [
    unique('notice_recipient_company_id_id_key').on(t.companyId, t.id),
    unique('notice_recipient_scope_key').on(t.companyId, t.propertyId, t.id),
    unique('notice_recipient_notice_key').on(t.companyId, t.noticeId, t.id),
    unique('notice_recipient_position_key').on(t.companyId, t.noticeId, t.position),
    foreignKey({
      name: 'notice_recipient_notice_fk',
      columns: [t.companyId, t.propertyId, t.noticeId],
      foreignColumns: [notice.companyId, notice.propertyId, notice.id],
    }),
    foreignKey({
      name: 'notice_recipient_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'notice_recipient_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    foreignKey({
      name: 'notice_recipient_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'notice_recipient_contact_fk',
      columns: [t.companyId, t.tenantId, t.tenantContactId],
      foreignColumns: [tenantContact.companyId, tenantContact.tenantId, tenantContact.id],
    }),
    foreignKey({
      name: 'notice_recipient_signer_fk',
      columns: [t.companyId, t.propertyId, t.signerId],
      foreignColumns: [signer.companyId, signer.propertyId, signer.id],
    }),
    index('notice_recipient_notice_idx').on(t.companyId, t.noticeId),
    index('notice_recipient_tenant_idx').on(t.companyId, t.tenantId),
    check('notice_recipient_kind_check', sql`${t.kind} in ('tenant', 'co_tenant', 'signatory')`),
    // A signatory or a co-tenant is one of the tenant's contacts; the tenant is the record itself.
    check(
      'notice_recipient_contact_check',
      sql`(${t.kind} in ('signatory', 'co_tenant')) = (${t.tenantContactId} is not null)`,
    ),
    check('notice_recipient_position_check', sql`${t.position} >= 1`),
  ],
);

/**
 * The notice's timeline (LN-03), append-only and server-timestamped: every status change and
 * every record that moves none. `dedupe_key` makes each ladder step, first open, delivery report
 * and signature land once however often its job runs.
 */
export const noticeEvent = pgTable(
  'notice_event',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    noticeId: uuid().notNull(),
    recipientId: uuid(),
    /** The recipient's tenant, for the tenant timeline; the notice's tenant for a notice-wide event. */
    tenantId: uuid(),
    kind: text().notNull(),
    channel: text(),
    messageId: uuid(),
    data: jsonb(),
    actorPersonId: uuid().references(() => person.id),
    occurredAt: tsNow(),
    dedupeKey: text(),
  },
  (t) => [
    unique('notice_event_company_id_id_key').on(t.companyId, t.id),
    uniqueIndex('notice_event_dedupe_key')
      .on(t.companyId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    foreignKey({
      name: 'notice_event_notice_fk',
      columns: [t.companyId, t.propertyId, t.noticeId],
      foreignColumns: [notice.companyId, notice.propertyId, notice.id],
    }),
    foreignKey({
      name: 'notice_event_recipient_fk',
      columns: [t.companyId, t.noticeId, t.recipientId],
      foreignColumns: [noticeRecipient.companyId, noticeRecipient.noticeId, noticeRecipient.id],
    }),
    foreignKey({
      name: 'notice_event_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    index('notice_event_notice_idx').on(t.companyId, t.noticeId, t.occurredAt),
    index('notice_event_tenant_idx').on(t.companyId, t.tenantId, t.occurredAt),
    check('notice_event_kind_check', sql`${t.kind} in (${list(NOTICE_EVENT_KINDS_SQL)})`),
    check(
      'notice_event_channel_check',
      sql`${t.channel} is null or ${t.channel} in (${list(CHANNELS)})`,
    ),
  ],
);

/**
 * Physical service (LN-05; plan 4.7), append-only: a correction is a new record that references
 * the one it corrects, on the same notice.
 */
export const serviceRecord = pgTable(
  'service_record',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    noticeId: uuid().notNull(),
    recipientId: uuid(),
    method: text().notNull(),
    servedAt: timestamp({ withTimezone: true }).notNull(),
    servedByPersonId: uuid().references(() => person.id),
    servedByName: text().notNull(),
    witnessName: text(),
    notes: text(),
    photoDocumentId: uuid(),
    affidavitDocumentId: uuid(),
    correctsRecordId: uuid(),
    recordedBy: uuid()
      .notNull()
      .references(() => person.id),
    recordedAt: tsNow(),
  },
  (t) => [
    unique('service_record_company_id_id_key').on(t.companyId, t.id),
    unique('service_record_notice_key').on(t.companyId, t.noticeId, t.id),
    uniqueIndex('service_record_corrects_key')
      .on(t.companyId, t.correctsRecordId)
      .where(sql`${t.correctsRecordId} is not null`),
    foreignKey({
      name: 'service_record_notice_fk',
      columns: [t.companyId, t.propertyId, t.noticeId],
      foreignColumns: [notice.companyId, notice.propertyId, notice.id],
    }),
    foreignKey({
      name: 'service_record_recipient_fk',
      columns: [t.companyId, t.noticeId, t.recipientId],
      foreignColumns: [noticeRecipient.companyId, noticeRecipient.noticeId, noticeRecipient.id],
    }),
    foreignKey({
      name: 'service_record_corrects_fk',
      columns: [t.companyId, t.noticeId, t.correctsRecordId],
      foreignColumns: [t.companyId, t.noticeId, t.id],
    }),
    foreignKey({
      name: 'service_record_photo_fk',
      columns: [t.companyId, t.photoDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'service_record_affidavit_fk',
      columns: [t.companyId, t.affidavitDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    index('service_record_notice_idx').on(t.companyId, t.noticeId, t.recordedAt),
    check(
      'service_record_method_check',
      sql`${t.method} in ('handed_to_tenant', 'posted_on_premises', 'left_with_adult_occupant', 'registered_post', 'courier')`,
    ),
  ],
);

/** A Rent Officer assessment of a unit (decision 3; Act 220 s.23), append-only. */
export const rentAssessment = pgTable(
  'rent_assessment',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    unitId: uuid().notNull(),
    assessedOn: day().notNull(),
    reference: text().notNull(),
    documentId: uuid(),
    /** M7 review C4: the record this one corrects, with why; a record is corrected once. */
    replacesId: uuid(),
    reason: text(),
    recordedBy: uuid()
      .notNull()
      .references(() => person.id),
    recordedAt: tsNow(),
  },
  (t) => [
    unique('rent_assessment_company_id_id_key').on(t.companyId, t.id),
    unique('rent_assessment_scope_key').on(t.companyId, t.unitId, t.id),
    unique('rent_assessment_replaces_key').on(t.companyId, t.replacesId),
    foreignKey({
      name: 'rent_assessment_replaces_fk',
      columns: [t.companyId, t.unitId, t.replacesId],
      foreignColumns: [t.companyId, t.unitId, t.id],
    }),
    check(
      'rent_assessment_reason_check',
      sql`(${t.replacesId} is null) = (${t.reason} is null) and (${t.reason} is null or length(${t.reason}) between 3 and 500)`,
    ),
    foreignKey({
      name: 'rent_assessment_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'rent_assessment_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    index('rent_assessment_unit_idx').on(t.companyId, t.unitId, t.assessedOn),
    check('rent_assessment_reference_check', sql`length(${t.reference}) between 1 and 120`),
  ],
);

/**
 * M7 review C4, append-only: a Rent Officer assessment recorded in error is voided, with a reason,
 * once. It stays listed; a voided or corrected record never counts towards the s.23 bar.
 */
export const rentAssessmentVoid = pgTable(
  'rent_assessment_void',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    unitId: uuid().notNull(),
    assessmentId: uuid().notNull(),
    reason: text().notNull(),
    voidedBy: uuid()
      .notNull()
      .references(() => person.id),
    voidedAt: tsNow(),
  },
  (t) => [
    unique('rent_assessment_void_company_id_id_key').on(t.companyId, t.id),
    unique('rent_assessment_void_once_key').on(t.companyId, t.assessmentId),
    foreignKey({
      name: 'rent_assessment_void_assessment_fk',
      columns: [t.companyId, t.unitId, t.assessmentId],
      foreignColumns: [rentAssessment.companyId, rentAssessment.unitId, rentAssessment.id],
    }),
    foreignKey({
      name: 'rent_assessment_void_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    check('rent_assessment_void_reason_check', sql`length(${t.reason}) between 3 and 500`),
  ],
);

/**
 * OQ-16 (decision 9), append-only: a company admin accepts the risk statement by typing their
 * name, or withdraws it. The statement's version and hash are kept with each row.
 */
export const noticeQuitAcknowledgement = pgTable(
  'notice_quit_acknowledgement',
  {
    id: id(),
    companyId: companyId(),
    action: text().notNull(),
    personId: uuid()
      .notNull()
      .references(() => person.id),
    membershipId: uuid().notNull(),
    typedName: text(),
    statementVersion: text().notNull(),
    statementSha256: text().notNull(),
    reason: text(),
    at: tsNow(),
  },
  (t) => [
    unique('notice_quit_acknowledgement_company_id_id_key').on(t.companyId, t.id),
    // M7 review data S3: the membership is the company's own.
    foreignKey({
      name: 'notice_quit_acknowledgement_membership_fk',
      columns: [t.companyId, t.membershipId],
      foreignColumns: [membership.companyId, membership.id],
    }),
    index('notice_quit_acknowledgement_idx').on(t.companyId, t.at),
    check('notice_quit_acknowledgement_action_check', sql`${t.action} in ('grant', 'withdraw')`),
    check(
      'notice_quit_acknowledgement_fields_check',
      sql`(${t.action} = 'grant') = (${t.typedName} is not null) and (${t.action} = 'withdraw') = (${t.reason} is not null)`,
    ),
    check('notice_quit_acknowledgement_sha_check', sql`${t.statementSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A staff task (CF-06; plan 4.1): an assignee, a due time and a related record. Mutable, with
 * audit triggers; an open task is completed or cancelled once (RA071). `dedupe_key` makes a job
 * create each task once.
 */
export const task = pgTable(
  'task',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    unitId: uuid(),
    tenantId: uuid(),
    kind: text().notNull(),
    title: text().notNull(),
    relatedType: text().notNull(),
    noticeId: uuid(),
    recipientId: uuid(),
    /** M8 (decision 6): a maintenance job attended in-house, or an inspection due. */
    jobId: uuid(),
    inspectionId: uuid(),
    assigneePersonId: uuid().references(() => person.id),
    dueAt: timestamp({ withTimezone: true }).notNull(),
    status: text().notNull().default('open'),
    note: text(),
    completedAt: ts(),
    completedBy: uuid().references(() => person.id),
    cancelledAt: ts(),
    cancelledBy: uuid().references(() => person.id),
    dedupeKey: text().notNull(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('task_company_id_id_key').on(t.companyId, t.id),
    unique('task_dedupe_key').on(t.companyId, t.dedupeKey),
    foreignKey({
      name: 'task_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    foreignKey({
      name: 'task_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'task_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    foreignKey({
      name: 'task_notice_fk',
      columns: [t.companyId, t.propertyId, t.noticeId],
      foreignColumns: [notice.companyId, notice.propertyId, notice.id],
    }),
    foreignKey({
      name: 'task_recipient_fk',
      columns: [t.companyId, t.noticeId, t.recipientId],
      foreignColumns: [noticeRecipient.companyId, noticeRecipient.noticeId, noticeRecipient.id],
    }),
    foreignKey({
      name: 'task_job_fk',
      columns: [t.companyId, t.propertyId, t.jobId],
      foreignColumns: [maintenanceJob.companyId, maintenanceJob.propertyId, maintenanceJob.id],
    }),
    foreignKey({
      name: 'task_inspection_fk',
      columns: [t.companyId, t.propertyId, t.inspectionId],
      foreignColumns: [inspection.companyId, inspection.propertyId, inspection.id],
    }),
    index('task_job_idx')
      .on(t.companyId, t.jobId)
      .where(sql`${t.jobId} is not null`),
    index('task_assignee_idx').on(t.companyId, t.assigneePersonId, t.status),
    index('task_list_idx').on(t.companyId, t.status, t.dueAt),
    check(
      'task_kind_check',
      sql`${t.kind} in ('notice_in_person_reminder', 'notice_post_on_premises', 'notice_physical_service', 'maintenance_attend', 'inspection_due')`,
    ),
    check('task_status_check', sql`${t.status} in ('open', 'done', 'cancelled')`),
    check(
      'task_related_check',
      sql`${t.relatedType} in ('notice', 'maintenance_job', 'inspection') and (${t.relatedType} = 'notice') = (${t.noticeId} is not null) and (${t.relatedType} = 'maintenance_job') = (${t.jobId} is not null) and (${t.relatedType} = 'inspection') = (${t.inspectionId} is not null)`,
    ),
    check(
      'task_closed_check',
      sql`(${t.status} = 'done') = (${t.completedAt} is not null) and (${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
    check('task_title_check', sql`length(${t.title}) between 1 and 200`),
  ],
);
