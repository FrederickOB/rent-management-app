import { sql } from 'drizzle-orm';
import {
  check,
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
import { company } from './company';
import { person } from './identity';
import { conversation, message, messageAttachment } from './messaging';
import { document } from './platform';
import { property, unit } from './register';
import { lease, tenant } from './tenancy';

/**
 * Maintenance jobs in their first state (CM-04 stub; M6 decision 12; MI-01). The bot creates a
 * reported job with its media and gives the tenant the ticket number; M8 builds triage,
 * assignment, artisans and the board on the same table. Security, triggers and grants are in
 * 0031_messaging_security.sql.
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
  },
  (t) => [
    unique('maintenance_job_company_id_id_key').on(t.companyId, t.id),
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
    check('maintenance_job_status_check', sql`${t.status} in ('reported')`),
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
  ],
);
