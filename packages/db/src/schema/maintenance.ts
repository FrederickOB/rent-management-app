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
import { company, membership } from './company';
import { secureLink } from './esign';
import { person } from './identity';
import { book, journalEntry } from './ledger';
import { conversation, message, messageAttachment } from './messaging';
import { document } from './platform';
import { owner, property, unit } from './register';
import { lease, tenant } from './tenancy';

/**
 * Maintenance (MI-01 to MI-06, MI-10, CM-04, AC-03). M6 created jobs in their first state from the
 * bot (0031_messaging_security.sql); M8 adds triage, assignment, artisans and their job sheets,
 * the job's event history, inspections and expenses on the same tables (plan 4.10). Security,
 * triggers and grants for M8 are in 0041_maintenance_security.sql.
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const companyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);
const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);
const ts = () => timestamp({ withTimezone: true });
const day = () => date({ mode: 'string' });
const minor = () => bigint({ mode: 'number' });
const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const CONDITIONS = ['good', 'fair', 'poor', 'damaged', 'missing', 'not_applicable'] as const;

/**
 * An artisan the company sends work to (MI-04; decision 6): name, phone and trades, archived and
 * never deleted. No rates, ratings or payment details (MI-09). Their channel consent is in
 * contact_consent_event. Company-level and staff only.
 */
export const artisan = pgTable(
  'artisan',
  {
    id: id(),
    companyId: companyId(),
    name: text().notNull(),
    /** E.164. Personal data (Act 843): never logged. */
    phone: text().notNull(),
    trades: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isTestContact: boolean().notNull().default(false),
    archivedAt: ts(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('artisan_company_id_id_key').on(t.companyId, t.id),
    unique('artisan_phone_key').on(t.companyId, t.phone),
    check('artisan_phone_check', sql`${t.phone} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check('artisan_name_check', sql`length(${t.name}) between 2 and 120`),
  ],
);

/**
 * Consent for people who are neither tenants nor their contacts (CM-09; decision 5): a staff
 * member's WhatsApp opt-in for emergency alerts, and an artisan's channels. The same record a
 * tenant's consent is (consent_event); append-only, each change a new row.
 */
export const contactConsentEvent = pgTable(
  'contact_consent_event',
  {
    id: id(),
    companyId: companyId(),
    subjectType: text().notNull(),
    membershipId: uuid(),
    artisanId: uuid(),
    channel: text().notNull(),
    action: text().notNull(),
    textVersion: text().notNull(),
    textSha256: text().notNull(),
    source: text().notNull(),
    recordedBy: uuid().references(() => person.id),
    recordedAt: tsNow(),
  },
  (t) => [
    unique('contact_consent_event_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'contact_consent_event_membership_fk',
      columns: [t.companyId, t.membershipId],
      foreignColumns: [membership.companyId, membership.id],
    }),
    foreignKey({
      name: 'contact_consent_event_artisan_fk',
      columns: [t.companyId, t.artisanId],
      foreignColumns: [artisan.companyId, artisan.id],
    }),
    index('contact_consent_event_membership_idx').on(t.companyId, t.membershipId, t.recordedAt),
    index('contact_consent_event_artisan_idx').on(t.companyId, t.artisanId, t.recordedAt),
    check(
      'contact_consent_event_subject_check',
      sql`(${t.subjectType} = 'staff' and ${t.membershipId} is not null and ${t.artisanId} is null) or (${t.subjectType} = 'artisan' and ${t.artisanId} is not null and ${t.membershipId} is null)`,
    ),
    check('contact_consent_event_channel_check', sql`${t.channel} in ('sms', 'whatsapp')`),
    check('contact_consent_event_action_check', sql`${t.action} in ('grant', 'withdraw')`),
    check(
      'contact_consent_event_source_check',
      sql`${t.source} in ('staff', 'self', 'stop_keyword')`,
    ),
    check('contact_consent_event_sha_check', sql`${t.textSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const maintenanceJob = pgTable(
  'maintenance_job',
  {
    id: id(),
    companyId: companyId(),
    /**
     * Per company, from 1, assigned by the database on insert (whatever the insert says), so a
     * scoped session never picks a number another property already has.
     */
    ticketNumber: integer().notNull().default(0),
    propertyId: uuid().notNull(),
    unitId: uuid(),
    leaseId: uuid(),
    tenantId: uuid(),
    status: text().notNull().default('reported'),
    source: text().notNull(),
    description: text().notNull(),
    /** The conversation and the first message it came from (CM-04): one ticket per report. */
    conversationId: uuid(),
    sourceMessageId: uuid(),
    /** Every message the report was made of (CM-04): their media join the job as they are copied. */
    sourceMessageIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    reportedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    // M8 (plan 4.10): triage, assignment, targets and the evidence of MI-06. The application may
    // update only these columns, and a trigger checks every status move (0041).
    priority: text(),
    category: text(),
    /** The tenant said it is an emergency (decision 5). */
    emergencyFlag: boolean().notNull().default(false),
    assigneeKind: text(),
    assigneePersonId: uuid().references(() => person.id),
    assigneeArtisanId: uuid(),
    /** The artisan's answer on the job sheet. */
    artisanResponse: text(),
    respondBy: ts(),
    completeBy: ts(),
    respondedAt: ts(),
    workDoneAt: ts(),
    closedAt: ts(),
    visitAt: ts(),
    beforePhotoReason: text(),
    completionNote: text(),
    tenantResponse: text(),
    tenantResponseReason: text(),
    tenantResponseAt: ts(),
    tenantResponseVia: text(),
    cancelReason: text(),
    /** The tenant app's own id for the request: a retry or an offline send makes one job. */
    clientId: uuid(),
  },
  (t) => [
    unique('maintenance_job_company_id_id_key').on(t.companyId, t.id),
    uniqueIndex('maintenance_job_client_key')
      .on(t.companyId, t.tenantId, t.clientId)
      .where(sql`${t.clientId} is not null`),
    foreignKey({
      name: 'maintenance_job_artisan_fk',
      columns: [t.companyId, t.assigneeArtisanId],
      foreignColumns: [artisan.companyId, artisan.id],
    }),
    unique('maintenance_job_scope_key').on(t.companyId, t.propertyId, t.id),
    unique('maintenance_job_ticket_key').on(t.companyId, t.ticketNumber),
    uniqueIndex('maintenance_job_source_message_key')
      .on(t.companyId, t.sourceMessageId)
      .where(sql`${t.sourceMessageId} is not null`),
    foreignKey({
      name: 'maintenance_job_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    foreignKey({
      name: 'maintenance_job_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'maintenance_job_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'maintenance_job_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    foreignKey({
      name: 'maintenance_job_conversation_fk',
      columns: [t.companyId, t.conversationId],
      foreignColumns: [conversation.companyId, conversation.id],
    }),
    foreignKey({
      name: 'maintenance_job_message_fk',
      columns: [t.companyId, t.sourceMessageId],
      foreignColumns: [message.companyId, message.id],
    }),
    index('maintenance_job_list_idx').on(t.companyId, t.status, t.createdAt),
    check(
      'maintenance_job_status_check',
      sql`${t.status} in ('reported', 'triaged', 'assigned', 'in_progress', 'work_done', 'closed', 'cancelled')`,
    ),
    check(
      'maintenance_job_priority_check',
      sql`${t.priority} is null or ${t.priority} in ('emergency', 'urgent', 'routine')`,
    ),
    check(
      'maintenance_job_category_check',
      sql`${t.category} is null or ${t.category} in ('plumbing', 'electrical', 'roofing', 'carpentry', 'painting', 'pest_control', 'air_conditioning', 'generator', 'borehole', 'septic', 'other')`,
    ),
    // Assigned or later needs an assignee; staff by person, an artisan by artisan.
    check(
      'maintenance_job_assignee_check',
      sql`(${t.assigneeKind} is null or ${t.assigneeKind} in ('staff', 'artisan')) and (${t.assigneeKind} = 'staff') = (${t.assigneePersonId} is not null) and (${t.assigneeKind} = 'artisan') = (${t.assigneeArtisanId} is not null) and (${t.artisanResponse} is null or (${t.assigneeKind} = 'artisan' and ${t.artisanResponse} in ('accepted', 'declined')))`,
    ),
    check(
      'maintenance_job_triaged_check',
      sql`${t.status} in ('reported', 'cancelled') or (${t.priority} is not null and ${t.category} is not null)`,
    ),
    check(
      'maintenance_job_tenant_response_check',
      sql`(${t.tenantResponse} is null or ${t.tenantResponse} in ('confirmed', 'disputed')) and (${t.tenantResponseVia} is null or ${t.tenantResponseVia} in ('app', 'whatsapp', 'sms', 'staff'))`,
    ),
    index('maintenance_job_board_idx').on(t.companyId, t.propertyId, t.status),
    check(
      'maintenance_job_source_check',
      sql`${t.source} in ('whatsapp', 'app', 'sms', 'email', 'staff')`,
    ),
    check('maintenance_job_ticket_check', sql`${t.ticketNumber} >= 1`),
    check('maintenance_job_lease_check', sql`${t.leaseId} is null or ${t.tenantId} is not null`),
  ],
);

/** A photo, video, voice note or document on a job (CM-04, MI-01). Append-only. */
export const maintenanceJobAttachment = pgTable(
  'maintenance_job_attachment',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    jobId: uuid().notNull(),
    documentId: uuid().notNull(),
    kind: text().notNull(),
    /** The message attachment it came from, when it came by message. */
    messageAttachmentId: uuid(),
    addedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    // M8 (MI-06; decision 2): when it was taken, who added it, and its size and length.
    stage: text().notNull().default('report'),
    addedByKind: text().notNull().default('message'),
    addedByArtisanId: uuid(),
    sizeBytes: bigint({ mode: 'number' }),
    durationSeconds: integer(),
  },
  (t) => [
    unique('maintenance_job_attachment_company_id_id_key').on(t.companyId, t.id),
    unique('maintenance_job_attachment_document_key').on(t.companyId, t.jobId, t.documentId),
    foreignKey({
      name: 'maintenance_job_attachment_job_fk',
      columns: [t.companyId, t.propertyId, t.jobId],
      foreignColumns: [maintenanceJob.companyId, maintenanceJob.propertyId, maintenanceJob.id],
    }),
    foreignKey({
      name: 'maintenance_job_attachment_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'maintenance_job_attachment_message_fk',
      columns: [t.companyId, t.messageAttachmentId],
      foreignColumns: [messageAttachment.companyId, messageAttachment.id],
    }),
    check(
      'maintenance_job_attachment_kind_check',
      sql`${t.kind} in ('image', 'video', 'audio', 'document')`,
    ),
    check(
      'maintenance_job_attachment_stage_check',
      sql`${t.stage} in ('report', 'before', 'after', 'other') and ${t.addedByKind} in ('staff', 'artisan', 'tenant', 'message')`,
    ),
    foreignKey({
      name: 'maintenance_job_attachment_artisan_fk',
      columns: [t.companyId, t.addedByArtisanId],
      foreignColumns: [artisan.companyId, artisan.id],
    }),
    index('maintenance_job_attachment_job_idx').on(t.companyId, t.jobId, t.stage),
  ],
);

/**
 * A job's history (plan 4.2): every step, note, alert and warning, with server time, who did it
 * and its data. Append-only. System events carry a dedupe key (an SLA warning once per job,
 * target and stage; an alert once per recipient and channel), so a retry records nothing twice.
 */
export const maintenanceJobEvent = pgTable(
  'maintenance_job_event',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    jobId: uuid().notNull(),
    kind: text().notNull(),
    actorKind: text().notNull(),
    actorPersonId: uuid().references(() => person.id),
    actorArtisanId: uuid(),
    data: jsonb(),
    dedupeKey: text(),
    at: tsNow(),
  },
  (t) => [
    unique('maintenance_job_event_company_id_id_key').on(t.companyId, t.id),
    uniqueIndex('maintenance_job_event_dedupe_key')
      .on(t.companyId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    foreignKey({
      name: 'maintenance_job_event_job_fk',
      columns: [t.companyId, t.propertyId, t.jobId],
      foreignColumns: [maintenanceJob.companyId, maintenanceJob.propertyId, maintenanceJob.id],
    }),
    foreignKey({
      name: 'maintenance_job_event_artisan_fk',
      columns: [t.companyId, t.actorArtisanId],
      foreignColumns: [artisan.companyId, artisan.id],
    }),
    index('maintenance_job_event_job_idx').on(t.companyId, t.jobId, t.at),
    check(
      'maintenance_job_event_kind_check',
      sql`${t.kind} in ('reported', 'triaged', 'priority_changed', 'assigned', 'unassigned', 'accepted', 'declined', 'visit_planned', 'started', 'work_done', 'confirmed', 'disputed', 'closed', 'auto_closed', 'cancelled', 'note', 'media_added', 'alerted', 'sla_warned', 'tenant_updated', 'expense_linked')`,
    ),
    check(
      'maintenance_job_event_actor_check',
      sql`${t.actorKind} in ('staff', 'artisan', 'tenant', 'system') and (${t.actorKind} <> 'artisan' or ${t.actorArtisanId} is not null) and (${t.actorKind} = 'artisan' or ${t.actorArtisanId} is null)`,
    ),
  ],
);

/**
 * A one-time code for an artisan's completion on the job sheet (decision 6): M3's rules (6 digits
 * stored as an HMAC, 10 minutes, 5 attempts), sent only to the artisan's phone on record. Kept
 * apart from otp_challenge, which belongs to e-sign signers.
 */
export const jobSheetCode = pgTable(
  'job_sheet_code',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    jobId: uuid().notNull(),
    artisanId: uuid().notNull(),
    secureLinkId: uuid().notNull(),
    channel: text().notNull(),
    destinationMasked: text().notNull(),
    destinationHash: text().notNull(),
    codeHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    consumedAt: ts(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('job_sheet_code_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'job_sheet_code_job_fk',
      columns: [t.companyId, t.propertyId, t.jobId],
      foreignColumns: [maintenanceJob.companyId, maintenanceJob.propertyId, maintenanceJob.id],
    }),
    foreignKey({
      name: 'job_sheet_code_artisan_fk',
      columns: [t.companyId, t.artisanId],
      foreignColumns: [artisan.companyId, artisan.id],
    }),
    foreignKey({
      name: 'job_sheet_code_link_fk',
      columns: [t.companyId, t.propertyId, t.secureLinkId],
      foreignColumns: [secureLink.companyId, secureLink.propertyId, secureLink.id],
    }),
    index('job_sheet_code_link_idx').on(t.companyId, t.secureLinkId, t.createdAt),
    index('job_sheet_code_destination_idx').on(t.companyId, t.destinationHash, t.createdAt),
    check('job_sheet_code_channel_check', sql`${t.channel} in ('sms', 'whatsapp')`),
    check('job_sheet_code_attempts_check', sql`${t.attempts} between 0 and ${t.maxAttempts}`),
  ],
);

/**
 * A company's own checklist for a unit type (decision 10): rooms, and items within each. Without
 * a row the domain's default applies. Configuration, not evidence: an inspection copies the rooms
 * and items it uses into its own rows.
 */
export const inspectionTemplate = pgTable(
  'inspection_template',
  {
    id: id(),
    companyId: companyId(),
    unitType: text().notNull(),
    rooms: jsonb().notNull(),
    updatedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('inspection_template_company_id_id_key').on(t.companyId, t.id),
    unique('inspection_template_unit_type_key').on(t.companyId, t.unitType),
    check('inspection_template_rooms_check', sql`jsonb_typeof(${t.rooms}) = 'array'`),
  ],
);

/**
 * An inspection (MI-10; plan 4.6): routine, move-in or move-out, room by room. Frozen once
 * submitted (0041); a correction is a new inspection that names the one it corrects. A move-out
 * inspection names the move-in one it is compared with.
 */
export const inspection = pgTable(
  'inspection',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    unitId: uuid().notNull(),
    leaseId: uuid(),
    tenantId: uuid(),
    kind: text().notNull(),
    status: text().notNull().default('in_progress'),
    unitType: text().notNull(),
    performedBy: uuid().references(() => person.id),
    startedAt: tsNow(),
    submittedAt: ts(),
    submittedBy: uuid().references(() => person.id),
    correctsInspectionId: uuid(),
    moveInInspectionId: uuid(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('inspection_company_id_id_key').on(t.companyId, t.id),
    unique('inspection_scope_key').on(t.companyId, t.propertyId, t.id),
    unique('inspection_lease_key').on(t.companyId, t.propertyId, t.leaseId, t.id),
    uniqueIndex('inspection_corrected_once')
      .on(t.companyId, t.correctsInspectionId)
      .where(sql`${t.correctsInspectionId} is not null`),
    foreignKey({
      name: 'inspection_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'inspection_lease_fk',
      columns: [t.companyId, t.propertyId, t.tenantId, t.leaseId],
      foreignColumns: [lease.companyId, lease.propertyId, lease.tenantId, lease.id],
    }),
    foreignKey({
      name: 'inspection_corrects_fk',
      columns: [t.companyId, t.propertyId, t.correctsInspectionId],
      foreignColumns: [t.companyId, t.propertyId, t.id],
    }),
    foreignKey({
      name: 'inspection_move_in_fk',
      columns: [t.companyId, t.propertyId, t.moveInInspectionId],
      foreignColumns: [t.companyId, t.propertyId, t.id],
    }),
    index('inspection_unit_idx').on(t.companyId, t.unitId, t.startedAt),
    index('inspection_lease_idx').on(t.companyId, t.leaseId, t.kind),
    check('inspection_kind_check', sql`${t.kind} in ('routine', 'move_in', 'move_out')`),
    check('inspection_status_check', sql`${t.status} in ('in_progress', 'submitted')`),
    check(
      'inspection_lease_check',
      sql`(${t.kind} = 'routine' or ${t.leaseId} is not null) and (${t.leaseId} is null or ${t.tenantId} is not null) and (${t.kind} = 'move_out' or ${t.moveInInspectionId} is null)`,
    ),
    check(
      'inspection_submitted_check',
      sql`(${t.status} = 'submitted') = (${t.submittedAt} is not null)`,
    ),
  ],
);

/** One item of an inspection: its room, its condition and a note (MI-10). Frozen with it. */
export const inspectionItem = pgTable(
  'inspection_item',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    inspectionId: uuid().notNull(),
    position: integer().notNull(),
    roomKey: text().notNull(),
    roomLabel: text().notNull(),
    itemKey: text().notNull(),
    itemLabel: text().notNull(),
    condition: text(),
    note: text(),
    /** On a move-out inspection: the same item at move-in. */
    moveInItemId: uuid(),
    updatedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('inspection_item_company_id_id_key').on(t.companyId, t.id),
    unique('inspection_item_scope_key').on(t.companyId, t.propertyId, t.inspectionId, t.id),
    unique('inspection_item_key').on(t.companyId, t.inspectionId, t.roomKey, t.itemKey),
    foreignKey({
      name: 'inspection_item_inspection_fk',
      columns: [t.companyId, t.propertyId, t.inspectionId],
      foreignColumns: [inspection.companyId, inspection.propertyId, inspection.id],
    }),
    foreignKey({
      name: 'inspection_item_move_in_fk',
      columns: [t.companyId, t.moveInItemId],
      foreignColumns: [t.companyId, t.id],
    }),
    check(
      'inspection_item_condition_check',
      sql`${t.condition} is null or ${t.condition} in (${list(CONDITIONS)})`,
    ),
    check('inspection_item_note_check', sql`${t.note} is null or length(${t.note}) <= 1000`),
  ],
);

/** A photo of an inspection item, stamped with the server's time (decision 10). Append-only. */
export const inspectionPhoto = pgTable(
  'inspection_photo',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    inspectionId: uuid().notNull(),
    itemId: uuid().notNull(),
    documentId: uuid().notNull(),
    addedBy: uuid().references(() => person.id),
    takenAt: tsNow(),
  },
  (t) => [
    unique('inspection_photo_company_id_id_key').on(t.companyId, t.id),
    unique('inspection_photo_document_key').on(t.companyId, t.itemId, t.documentId),
    foreignKey({
      name: 'inspection_photo_item_fk',
      columns: [t.companyId, t.propertyId, t.inspectionId, t.itemId],
      foreignColumns: [
        inspectionItem.companyId,
        inspectionItem.propertyId,
        inspectionItem.inspectionId,
        inspectionItem.id,
      ],
    }),
    foreignKey({
      name: 'inspection_photo_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    index('inspection_photo_inspection_idx').on(t.companyId, t.inspectionId),
  ],
);

/**
 * An expense (AC-03; decision 8): on a property or unit, in its owner's book, posted by P15 in the
 * same transaction (Dr 5000 or 5400; Cr 2500 unpaid, 1070 paid by the agent, 1010 by the owner).
 * Append-only: a payable paid later is an expense_payment, a mistake an expense_reversal (P21a)
 * and a new expense. Its status is derived from those.
 */
export const expense = pgTable(
  'expense',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    unitId: uuid(),
    ownerId: uuid().notNull(),
    bookId: uuid().notNull(),
    category: text().notNull(),
    supplierName: text().notNull(),
    amountMinor: minor().notNull(),
    currency: char({ length: 3 }).notNull().default('GHS'),
    expenseDate: day().notNull(),
    paidBy: text().notNull(),
    receiptDocumentId: uuid(),
    jobId: uuid(),
    note: text(),
    entryId: uuid().notNull(),
    accountingDate: day().notNull(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('expense_company_id_id_key').on(t.companyId, t.id),
    unique('expense_scope_key').on(t.companyId, t.propertyId, t.id),
    foreignKey({
      name: 'expense_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    foreignKey({
      name: 'expense_unit_fk',
      columns: [t.companyId, t.propertyId, t.unitId],
      foreignColumns: [unit.companyId, unit.propertyId, unit.id],
    }),
    foreignKey({
      name: 'expense_owner_fk',
      columns: [t.companyId, t.ownerId],
      foreignColumns: [owner.companyId, owner.id],
    }),
    foreignKey({
      name: 'expense_book_fk',
      columns: [t.companyId, t.bookId],
      foreignColumns: [book.companyId, book.id],
    }),
    foreignKey({
      name: 'expense_receipt_fk',
      columns: [t.companyId, t.receiptDocumentId],
      foreignColumns: [document.companyId, document.id],
    }),
    foreignKey({
      name: 'expense_job_fk',
      columns: [t.companyId, t.propertyId, t.jobId],
      foreignColumns: [maintenanceJob.companyId, maintenanceJob.propertyId, maintenanceJob.id],
    }),
    foreignKey({
      name: 'expense_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    index('expense_property_idx').on(t.companyId, t.propertyId, t.expenseDate),
    index('expense_owner_idx').on(t.companyId, t.ownerId, t.accountingDate),
    index('expense_job_idx')
      .on(t.companyId, t.jobId)
      .where(sql`${t.jobId} is not null`),
    check(
      'expense_category_check',
      sql`${t.category} in ('repairs', 'rates', 'insurance', 'utilities', 'cleaning', 'security', 'legal', 'other')`,
    ),
    check('expense_paid_by_check', sql`${t.paidBy} in ('owner', 'agent', 'unpaid')`),
    check('expense_amount_check', sql`${t.amountMinor} > 0`),
    check('expense_currency_check', sql`${t.currency} = 'GHS'`),
    check('expense_supplier_check', sql`length(${t.supplierName}) between 2 and 120`),
    check('expense_dates_check', sql`${t.accountingDate} >= ${t.expenseDate}`),
  ],
);

/** An unpaid expense paid later (P15: Dr 2500, Cr 1010 or 1070). Once per expense; append-only. */
export const expensePayment = pgTable(
  'expense_payment',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    expenseId: uuid().notNull(),
    paidOn: day().notNull(),
    paidFrom: text().notNull(),
    reference: text(),
    entryId: uuid().notNull(),
    accountingDate: day().notNull(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('expense_payment_company_id_id_key').on(t.companyId, t.id),
    unique('expense_payment_once').on(t.companyId, t.expenseId),
    foreignKey({
      name: 'expense_payment_expense_fk',
      columns: [t.companyId, t.propertyId, t.expenseId],
      foreignColumns: [expense.companyId, expense.propertyId, expense.id],
    }),
    foreignKey({
      name: 'expense_payment_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    check('expense_payment_from_check', sql`${t.paidFrom} in ('owner_account', 'agency_account')`),
    check('expense_payment_dates_check', sql`${t.accountingDate} >= ${t.paidOn}`),
  ],
);

/**
 * An expense recorded in error, reversed (P21a: the expense's entry, and its payment's if paid,
 * each line negated). Once per expense; append-only. The right one is a new expense.
 */
export const expenseReversal = pgTable(
  'expense_reversal',
  {
    id: id(),
    companyId: companyId(),
    propertyId: uuid().notNull(),
    expenseId: uuid().notNull(),
    reason: text().notNull(),
    entryId: uuid().notNull(),
    paymentEntryId: uuid(),
    valueDate: day().notNull(),
    accountingDate: day().notNull(),
    createdBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('expense_reversal_company_id_id_key').on(t.companyId, t.id),
    unique('expense_reversal_once').on(t.companyId, t.expenseId),
    foreignKey({
      name: 'expense_reversal_expense_fk',
      columns: [t.companyId, t.propertyId, t.expenseId],
      foreignColumns: [expense.companyId, expense.propertyId, expense.id],
    }),
    foreignKey({
      name: 'expense_reversal_entry_fk',
      columns: [t.companyId, t.entryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    foreignKey({
      name: 'expense_reversal_payment_entry_fk',
      columns: [t.companyId, t.paymentEntryId],
      foreignColumns: [journalEntry.companyId, journalEntry.id],
    }),
    check('expense_reversal_reason_check', sql`length(${t.reason}) between 3 and 500`),
    check('expense_reversal_dates_check', sql`${t.accountingDate} >= ${t.valueDate}`),
  ],
);
