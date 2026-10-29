import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { company } from './company';
import { signer } from './esign';
import { person } from './identity';
import { tenant, tenantContact } from './tenancy';

/**
 * The outbound messaging core (M3 decision 1; CLAUDE.md section 8). A message is recorded once, as
 * it was composed, with any link token redacted; what happens to it is a series of events. Both
 * tables are append-only: messages are never edited or deleted.
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const companyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);

export const message = pgTable(
  'message',
  {
    /** Chosen by whoever queues the message, so they can refer to it before it is sent. */
    id: uuid().primaryKey(),
    companyId: companyId(),
    /** Set when the message concerns a property or a tenancy, for the scope policies. */
    propertyId: uuid(),
    tenantId: uuid(),
    recipientType: text().notNull(),
    tenantContactId: uuid(),
    staffPersonId: uuid().references(() => person.id),
    signerId: uuid(),
    purpose: text().notNull(),
    subject: text(),
    /** As composed, with the link shown as [link] and any secure-link token redacted. */
    body: text().notNull(),
    /** The kind of link the send job adds where the body says [link], if any. */
    linkPurpose: text(),
    /** What the link is for, such as the signer or the identity check. */
    linkTargetId: uuid(),
    /** The channels it may go by, in order of preference. */
    channels: text().array().notNull(),
    isTestContact: boolean().notNull().default(false),
    /** What the message is about, for timelines: lease, id_check, signing_request. */
    relatedType: text(),
    relatedId: uuid(),
    requestedBy: uuid().references(() => person.id),
    createdAt: tsNow(),
  },
  (t) => [
    unique('message_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'message_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    foreignKey({
      name: 'message_contact_fk',
      columns: [t.companyId, t.tenantId, t.tenantContactId],
      foreignColumns: [tenantContact.companyId, tenantContact.tenantId, tenantContact.id],
    }),
    foreignKey({
      name: 'message_signer_fk',
      columns: [t.companyId, t.signerId],
      foreignColumns: [signer.companyId, signer.id],
    }),
    index('message_tenant_idx').on(t.companyId, t.tenantId, t.createdAt),
    index('message_related_idx').on(t.companyId, t.relatedType, t.relatedId),
    check(
      'message_recipient_check',
      sql`${t.recipientType} in ('tenant', 'tenant_contact', 'staff', 'signer') and (${t.recipientType} <> 'tenant' or ${t.tenantId} is not null) and (${t.recipientType} <> 'tenant_contact' or ${t.tenantContactId} is not null) and (${t.recipientType} <> 'staff' or ${t.staffPersonId} is not null) and (${t.recipientType} <> 'signer' or ${t.signerId} is not null)`,
    ),
    check(
      'message_purpose_check',
      sql`${t.purpose} in ('signing_link', 'signing_reminder', 'signed_copy', 'id_check_link', 'staff_notice')`,
    ),
    check(
      'message_link_check',
      sql`(${t.linkPurpose} is null or ${t.linkPurpose} in ('sign', 'id_capture')) and (${t.linkPurpose} is null) = (${t.linkTargetId} is null)`,
    ),
    check(
      'message_channels_check',
      sql`cardinality(${t.channels}) >= 1 and ${t.channels} <@ array['sms', 'email']::text[]`,
    ),
  ],
);

/** What happened to a message: queued, sent, delivered, failed or not sent (and why). */
export const messageEvent = pgTable(
  'message_event',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    companyId: companyId(),
    messageId: uuid().notNull(),
    status: text().notNull(),
    channel: text(),
    provider: text(),
    providerMessageId: text(),
    costMinor: bigint({ mode: 'number' }),
    currency: char({ length: 3 }),
    /** A masked phone number or email, never the full one. */
    destinationMasked: text(),
    /** no_consent, no_address, test_contact, provider_error, delivery_failed and the like. */
    reason: text(),
    occurredAt: tsNow(),
  },
  (t) => [
    unique('message_event_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'message_event_message_fk',
      columns: [t.companyId, t.messageId],
      foreignColumns: [message.companyId, message.id],
    }),
    index('message_event_message_idx').on(t.companyId, t.messageId, t.occurredAt),
    uniqueIndex('message_event_provider_key')
      .on(t.provider, t.providerMessageId)
      .where(sql`${t.status} = 'sent'`),
    check(
      'message_event_status_check',
      sql`${t.status} in ('queued', 'sent', 'delivered', 'failed', 'not_sent')`,
    ),
    check(
      'message_event_channel_check',
      sql`${t.channel} is null or ${t.channel} in ('sms', 'email')`,
    ),
    check(
      'message_event_sent_check',
      sql`${t.status} <> 'sent' or (${t.channel} is not null and ${t.provider} is not null and ${t.providerMessageId} is not null)`,
    ),
    check(
      'message_event_cost_check',
      sql`(${t.costMinor} is null) = (${t.currency} is null) and (${t.costMinor} is null or ${t.costMinor} >= 0)`,
    ),
  ],
);
