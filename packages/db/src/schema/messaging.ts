import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { company } from './company';
import { signer } from './esign';
import { person, session } from './identity';
import { document } from './platform';
import { property } from './register';
import { tenant, tenantContact } from './tenancy';

/**
 * Messaging (M3 decision 1; M6 plan 4.2; CLAUDE.md section 8). A message is recorded once, as it
 * was composed or as it arrived, with any link token redacted; what happens to it is a series of
 * events. Messages, their events and their attachments are append-only: never edited or deleted.
 *
 * M6 adds inbound messages, conversations (one thread per tenant per company, CM-05), the
 * WhatsApp numbers and templates, the bot's sessions, email reply and unsubscribe tokens, push
 * devices, tenant groups and broadcasts. Security, triggers and grants are in the hand-written
 * migration that follows the generated one (0031_messaging_security.sql).
 */
const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });
const companyId = () =>
  uuid()
    .notNull()
    .references(() => company.id);
const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`);

const CHANNELS_SQL = `'push', 'whatsapp', 'sms', 'email', 'in_app'`;

/**
 * A WhatsApp Business number (CM-01; decision 3): the shared platform number, or a company's own
 * number registered by a platform admin. A platform table, not company-scoped: the application
 * reads it only through narrow system functions (ADR-002).
 */
export const whatsappAccount = pgTable(
  'whatsapp_account',
  {
    id: id(),
    /** Meta's phone number id: what webhooks and the send API name. */
    phoneNumberId: text().notNull(),
    /** Meta's WhatsApp Business Account id. */
    wabaId: text().notNull(),
    /** E.164. */
    displayPhone: text().notNull(),
    displayName: text().notNull(),
    kind: text().notNull(),
    /** A company number's owner. Not `company_id`: this is a platform table, not company-scoped. */
    ownerCompanyId: uuid().references(() => company.id),
    status: text().notNull().default('active'),
    registeredBy: uuid().references(() => person.id),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    uniqueIndex('whatsapp_account_number_key').on(t.phoneNumberId),
    uniqueIndex('whatsapp_account_one_shared')
      .on(t.kind)
      .where(sql`${t.kind} = 'shared' and ${t.status} = 'active'`),
    uniqueIndex('whatsapp_account_one_per_company')
      .on(t.ownerCompanyId)
      .where(sql`${t.kind} = 'company' and ${t.status} = 'active'`),
    check('whatsapp_account_kind_check', sql`${t.kind} in ('shared', 'company')`),
    check(
      'whatsapp_account_company_check',
      sql`(${t.kind} = 'company') = (${t.ownerCompanyId} is not null)`,
    ),
    check('whatsapp_account_status_check', sql`${t.status} in ('active', 'retired')`),
    check('whatsapp_account_phone_check', sql`${t.displayPhone} ~ '^\\+[1-9][0-9]{6,14}$'`),
  ],
);

/**
 * Our message templates (CM-07): our text, its WhatsApp name, category and language. Platform
 * data, versioned and append-only: a changed text is a new version with its own WhatsApp name.
 */
export const messageTemplate = pgTable(
  'message_template',
  {
    id: id(),
    key: text().notNull(),
    version: integer().notNull(),
    whatsappName: text().notNull(),
    category: text().notNull(),
    language: text().notNull(),
    body: text().notNull(),
    /** The parameter names, in order: `{{1}}` is the first. */
    parameters: jsonb().notNull(),
    createdBy: text().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('message_template_version_key').on(t.key, t.language, t.version),
    unique('message_template_whatsapp_name_key').on(t.whatsappName, t.language),
    check(
      'message_template_category_check',
      sql`${t.category} in ('utility', 'marketing', 'authentication')`,
    ),
    check('message_template_version_check', sql`${t.version} >= 1`),
    // Meta's rule: lower case, digits and underscores, at most 512 characters.
    check(
      'message_template_name_check',
      sql`${t.whatsappName} ~ '^[a-z0-9_]+$' and char_length(${t.whatsappName}) <= 512`,
    ),
  ],
);

/**
 * A template's approval on one WhatsApp number (CM-07), kept current by Meta's template webhook
 * and a daily check. A platform table, read and written through narrow system functions.
 */
export const whatsappTemplateStatus = pgTable(
  'whatsapp_template_status',
  {
    id: id(),
    whatsappAccountId: uuid()
      .notNull()
      .references(() => whatsappAccount.id),
    templateId: uuid()
      .notNull()
      .references(() => messageTemplate.id),
    status: text().notNull(),
    /** The category Meta assigned, which can differ from the one asked for. */
    category: text(),
    metaTemplateId: text(),
    reason: text(),
    checkedAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('whatsapp_template_status_key').on(t.whatsappAccountId, t.templateId),
    check(
      'whatsapp_template_status_check',
      sql`${t.status} in ('pending', 'approved', 'rejected', 'paused', 'disabled')`,
    ),
    check(
      'whatsapp_template_status_category_check',
      sql`${t.category} is null or ${t.category} in ('utility', 'marketing', 'authentication')`,
    ),
  ],
);

/**
 * One thread per tenant in each company, across every channel (CM-05), or a triage row for an
 * unknown number or address (CM-02). Its state follows architecture section 7. Mutable, and every
 * change to its state, assignee, tags or tenant is row-audited; `last_message_at` is not, as it
 * moves with every message.
 */
export const conversation = pgTable(
  'conversation',
  {
    id: id(),
    companyId: companyId(),
    /** Null for triage until staff link it to a tenant. */
    tenantId: uuid(),
    /** For triage: the channel and address (E.164 phone or lower-case email) that wrote in. */
    triageChannel: text(),
    triageAddress: text(),
    /** A triage conversation linked to a tenant who already had one: its messages show there. */
    mergedIntoId: uuid(),
    state: text().notNull(),
    assignedTo: uuid().references(() => person.id),
    tags: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The bot handed over: why (plan 4.5), and when the person was asked for. */
    handoverReason: text(),
    handedOverAt: ts(),
    /** CM-06 and decision 10: when the first staff reply is due; null when none is owed. */
    firstResponseDueAt: ts(),
    lastMessageAt: ts(),
    lastInboundAt: ts(),
    lastInboundChannel: text(),
    resolvedAt: ts(),
    resolvedBy: uuid().references(() => person.id),
    /** Who linked a triage conversation to its tenant, and when (CM-02). */
    linkedBy: uuid().references(() => person.id),
    linkedAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('conversation_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'conversation_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    foreignKey({
      name: 'conversation_merged_fk',
      columns: [t.companyId, t.mergedIntoId],
      foreignColumns: [t.companyId, t.id],
    }),
    uniqueIndex('conversation_one_per_tenant')
      .on(t.companyId, t.tenantId)
      .where(sql`${t.tenantId} is not null and ${t.mergedIntoId} is null`),
    uniqueIndex('conversation_one_triage_per_address')
      .on(t.companyId, t.triageChannel, t.triageAddress)
      .where(sql`${t.tenantId} is null and ${t.mergedIntoId} is null`),
    index('conversation_list_idx').on(t.companyId, t.state, t.lastMessageAt),
    index('conversation_assignee_idx').on(t.companyId, t.assignedTo, t.state),
    index('conversation_due_idx')
      .on(t.companyId, t.firstResponseDueAt)
      .where(sql`${t.firstResponseDueAt} is not null`),
    check(
      'conversation_state_check',
      sql`${t.state} in ('triage', 'bot', 'open', 'assigned', 'awaiting_tenant', 'resolved')`,
    ),
    check(
      'conversation_triage_check',
      sql`(${t.tenantId} is not null or (${t.triageChannel} is not null and ${t.triageAddress} is not null)) and (${t.state} <> 'triage' or ${t.tenantId} is null)`,
    ),
    check(
      'conversation_triage_channel_check',
      sql`${t.triageChannel} is null or ${t.triageChannel} in ('whatsapp', 'sms', 'email')`,
    ),
    check(
      'conversation_inbound_channel_check',
      sql`${t.lastInboundChannel} is null or ${t.lastInboundChannel} in (${sql.raw(CHANNELS_SQL)})`,
    ),
    check(
      'conversation_assigned_check',
      sql`${t.state} <> 'assigned' or ${t.assignedTo} is not null`,
    ),
    check(
      'conversation_handover_check',
      sql`${t.handoverReason} is null or ${t.handoverReason} in ('asked_for_person', 'bot_cannot_help', 'media_received', 'contact_without_account', 'no_lease')`,
    ),
    check(
      'conversation_merge_check',
      sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
    ),
    check('conversation_tags_check', sql`cardinality(${t.tags}) <= 30`),
  ],
);

/**
 * What happened on one channel and address of a conversation, for the reply window, WhatsApp's
 * window and shared-number routing (decisions 4 and 6). Mutable, not audited: it moves with
 * every message.
 */
export const conversationChannel = pgTable(
  'conversation_channel',
  {
    id: id(),
    companyId: companyId(),
    conversationId: uuid().notNull(),
    channel: text().notNull(),
    /** E.164 phone, lower-case email, or for in-app and push the person's id. */
    address: text().notNull(),
    /** For WhatsApp: the number this thread is on. */
    whatsappAccountId: uuid(),
    lastInboundAt: ts(),
    lastOutboundAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('conversation_channel_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'conversation_channel_conversation_fk',
      columns: [t.companyId, t.conversationId],
      foreignColumns: [conversation.companyId, conversation.id],
    }),
    foreignKey({
      name: 'conversation_channel_account_fk',
      columns: [t.whatsappAccountId],
      foreignColumns: [whatsappAccount.id],
    }),
    unique('conversation_channel_key')
      .on(t.companyId, t.conversationId, t.channel, t.address, t.whatsappAccountId)
      .nullsNotDistinct(),
    index('conversation_channel_address_idx').on(t.channel, t.address, t.lastOutboundAt),
    check('conversation_channel_channel_check', sql`${t.channel} in (${sql.raw(CHANNELS_SQL)})`),
    check(
      'conversation_channel_account_check',
      sql`(${t.channel} = 'whatsapp') = (${t.whatsappAccountId} is not null)`,
    ),
  ],
);

export const message = pgTable(
  'message',
  {
    /** Chosen by whoever queues the message, so they can refer to it before it is sent. */
    id: uuid().primaryKey(),
    companyId: companyId(),
    /** Set when the message concerns a property or a tenancy, for the scope policies. */
    propertyId: uuid(),
    tenantId: uuid(),
    /** Outbound only: who it is to. Inbound messages have an author instead. */
    recipientType: text(),
    tenantContactId: uuid(),
    staffPersonId: uuid().references(() => person.id),
    signerId: uuid(),
    /** An owner of the register (M4b: settlement-account alerts, ADR-008). */
    ownerId: uuid(),
    purpose: text().notNull(),
    subject: text(),
    /**
     * As composed, with the link shown as [link] and any secure-link token redacted. Inbound: as
     * it arrived (an email's reply, without the quoted thread; empty for media alone).
     */
    body: text().notNull(),
    /** Inbound email: the whole message as received, quoted thread and all (plan 4.4). */
    fullBody: text(),
    /** The kind of link the send job adds where the body says [link], if any. */
    linkPurpose: text(),
    /** What the link is for, such as the signer or the identity check. */
    linkTargetId: uuid(),
    /** The channels it may go by, in order of preference. Inbound: the one it came on. */
    channels: text().array().notNull(),
    isTestContact: boolean().notNull().default(false),
    /** What the message is about, for timelines: lease, id_check, signing_request. */
    relatedType: text(),
    relatedId: uuid(),
    requestedBy: uuid().references(() => person.id),
    // M6 (plan 4.2).
    direction: text().notNull().default('outbound'),
    conversationId: uuid(),
    /** staff, bot or system (outbound); tenant, contact or unknown (inbound). */
    authorType: text().notNull().default('system'),
    authorPersonId: uuid().references(() => person.id),
    /** The one channel of an inbound message or a reply on a fixed channel. */
    channel: text(),
    /** The template it was sent with, when WhatsApp needed one outside the window (CM-07). */
    templateKey: text(),
    templateVersion: integer(),
    /** Inbound: the provider and its message id, unique, so a repeated webhook makes one row. */
    provider: text(),
    providerMessageId: text(),
    /** Inbound: the media items it carried, so the thread can show them before they are copied. */
    attachmentCount: smallint().notNull().default(0),
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
    foreignKey({
      name: 'message_conversation_fk',
      columns: [t.companyId, t.conversationId],
      foreignColumns: [conversation.companyId, conversation.id],
    }),
    index('message_tenant_idx').on(t.companyId, t.tenantId, t.createdAt),
    index('message_related_idx').on(t.companyId, t.relatedType, t.relatedId),
    index('message_conversation_idx').on(t.companyId, t.conversationId, t.createdAt),
    uniqueIndex('message_inbound_provider_key')
      .on(t.provider, t.providerMessageId)
      .where(sql`${t.direction} = 'inbound'`),
    check(
      'message_recipient_check',
      sql`(${t.recipientType} is null or ${t.recipientType} in ('tenant', 'tenant_contact', 'staff', 'signer', 'owner')) and (${t.recipientType} is distinct from 'tenant' or ${t.tenantId} is not null) and (${t.recipientType} is distinct from 'tenant_contact' or ${t.tenantContactId} is not null) and (${t.recipientType} is distinct from 'staff' or ${t.staffPersonId} is not null) and (${t.recipientType} is distinct from 'signer' or ${t.signerId} is not null) and (${t.recipientType} is distinct from 'owner' or ${t.ownerId} is not null)`,
    ),
    check(
      'message_purpose_check',
      sql`${t.purpose} in ('signing_link', 'signing_reminder', 'signed_copy', 'id_check_link', 'staff_notice', 'pay_link', 'rent_reminder', 'receipt', 'settlement_alert', 'conversation_reply', 'bot_reply', 'broadcast', 'opt_out_confirmation', 'consent_request', 'overdue_alert', 'renewal_reminder', 'paid_until_prompt', 'inbound')`,
    ),
    check(
      'message_link_check',
      sql`(${t.linkPurpose} is null or ${t.linkPurpose} in ('sign', 'signed_copy', 'id_capture', 'pay', 'receipt')) and (${t.linkPurpose} is null) = (${t.linkTargetId} is null)`,
    ),
    check(
      'message_channels_check',
      sql`cardinality(${t.channels}) >= 1 and ${t.channels} <@ array[${sql.raw(CHANNELS_SQL)}]::text[]`,
    ),
    check('message_direction_check', sql`${t.direction} in ('outbound', 'inbound')`),
    check(
      'message_author_check',
      sql`${t.authorType} in ('staff', 'bot', 'system', 'tenant', 'contact', 'unknown') and (${t.authorType} <> 'staff' or ${t.authorPersonId} is not null)`,
    ),
    check(
      'message_channel_check',
      sql`${t.channel} is null or ${t.channel} in (${sql.raw(CHANNELS_SQL)})`,
    ),
    check(
      'message_inbound_check',
      // Inbound: from the tenant's side, on one channel, in a conversation; by provider unless
      // written in the app (the API's own id makes it idempotent there).
      sql`case when ${t.direction} = 'inbound' then ${t.recipientType} is null and ${t.authorType} in ('tenant', 'contact', 'unknown') and ${t.purpose} = 'inbound' and ${t.channel} is not null and ${t.channel} <> 'push' and ${t.conversationId} is not null and (${t.channel} = 'in_app' or (${t.provider} is not null and ${t.providerMessageId} is not null)) else ${t.recipientType} is not null and ${t.authorType} in ('staff', 'bot', 'system') and ${t.purpose} <> 'inbound' and ${t.providerMessageId} is null end`,
    ),
    check(
      'message_template_check',
      sql`(${t.templateKey} is null) = (${t.templateVersion} is null)`,
    ),
    check(
      'message_attachment_count_check',
      sql`${t.attachmentCount} >= 0 and ${t.attachmentCount} <= 20`,
    ),
  ],
);

/** What happened to a message: queued, sent, delivered, read, failed or not sent (and why). */
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
    /** WhatsApp's pricing category and whether Meta bills it (CM-12 groundwork; decision 13). */
    pricingCategory: text(),
    billable: boolean(),
    /** The WhatsApp template a `sent` event went as, outside the 24-hour window (CM-07). */
    templateKey: text(),
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
    /** A repeated delivery report records nothing new (plan section 6, CM-02). */
    uniqueIndex('message_event_receipt_key')
      .on(t.companyId, t.messageId, t.channel, t.status)
      .where(sql`${t.status} in ('delivered', 'read')`),
    /** M6 review (S-10): a failure a provider reported, once per provider message. */
    uniqueIndex('message_event_failure_report_key')
      .on(t.provider, t.providerMessageId, t.status)
      .where(sql`${t.status} = 'failed' and ${t.providerMessageId} is not null`),
    check(
      'message_event_status_check',
      sql`${t.status} in ('queued', 'sent', 'delivered', 'read', 'failed', 'not_sent')`,
    ),
    check(
      'message_event_channel_check',
      sql`${t.channel} is null or ${t.channel} in (${sql.raw(CHANNELS_SQL)})`,
    ),
    check(
      'message_event_sent_check',
      sql`${t.status} <> 'sent' or (${t.channel} is not null and ${t.provider} is not null and ${t.providerMessageId} is not null)`,
    ),
    check(
      'message_event_cost_check',
      sql`(${t.costMinor} is null) = (${t.currency} is null) and (${t.costMinor} is null or ${t.costMinor} >= 0)`,
    ),
    check(
      'message_event_pricing_check',
      sql`${t.pricingCategory} is null or ${t.pricingCategory} in ('utility', 'marketing', 'authentication', 'service', 'referral_conversion')`,
    ),
  ],
);

/**
 * A file a message carries (CM-02, CM-04; plan 4.4): inbound media copied to our storage at once,
 * or a document we sent. Append-only: one row once the copy is done (or refused, with why); until
 * then the message's `attachment_count` says how many are coming.
 */
export const messageAttachment = pgTable(
  'message_attachment',
  {
    id: id(),
    companyId: companyId(),
    messageId: uuid().notNull(),
    kind: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }),
    /** The stored copy; null when it was refused (type or size). */
    documentId: uuid(),
    status: text().notNull(),
    rejectReason: text(),
    provider: text(),
    providerMediaId: text(),
    filename: text(),
    caption: text(),
    copiedAt: ts(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('message_attachment_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'message_attachment_message_fk',
      columns: [t.companyId, t.messageId],
      foreignColumns: [message.companyId, message.id],
    }),
    foreignKey({
      name: 'message_attachment_document_fk',
      columns: [t.companyId, t.documentId],
      foreignColumns: [document.companyId, document.id],
    }),
    index('message_attachment_message_idx').on(t.companyId, t.messageId),
    uniqueIndex('message_attachment_media_key')
      .on(t.provider, t.providerMediaId)
      .where(sql`${t.providerMediaId} is not null`),
    check(
      'message_attachment_kind_check',
      sql`${t.kind} in ('image', 'video', 'audio', 'document', 'sticker')`,
    ),
    check('message_attachment_status_check', sql`${t.status} in ('stored', 'rejected')`),
    check(
      'message_attachment_stored_check',
      sql`case when ${t.status} = 'stored' then ${t.documentId} is not null and ${t.rejectReason} is null else ${t.documentId} is null and ${t.rejectReason} is not null end`,
    ),
    check(
      'message_attachment_provider_check',
      sql`${t.providerMediaId} is null or ${t.provider} is not null`,
    ),
  ],
);

/**
 * A phone or email that staff linked to a tenant from triage (CM-02), with who linked it and
 * when. Later messages from it follow. Revoked, never deleted.
 */
export const channelIdentity = pgTable(
  'channel_identity',
  {
    id: id(),
    companyId: companyId(),
    channel: text().notNull(),
    /** E.164 phone or lower-case email. */
    address: text().notNull(),
    tenantId: uuid().notNull(),
    tenantContactId: uuid(),
    /** The triage conversation it was linked from. */
    conversationId: uuid(),
    linkedBy: uuid()
      .notNull()
      .references(() => person.id),
    linkedAt: tsNow(),
    revokedAt: ts(),
    revokedBy: uuid().references(() => person.id),
  },
  (t) => [
    unique('channel_identity_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'channel_identity_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    foreignKey({
      name: 'channel_identity_contact_fk',
      columns: [t.companyId, t.tenantId, t.tenantContactId],
      foreignColumns: [tenantContact.companyId, tenantContact.tenantId, tenantContact.id],
    }),
    foreignKey({
      name: 'channel_identity_conversation_fk',
      columns: [t.companyId, t.conversationId],
      foreignColumns: [conversation.companyId, conversation.id],
    }),
    uniqueIndex('channel_identity_active_key')
      .on(t.companyId, t.channel, t.address)
      .where(sql`${t.revokedAt} is null`),
    index('channel_identity_address_idx').on(t.channel, t.address),
    check('channel_identity_channel_check', sql`${t.channel} in ('whatsapp', 'sms', 'email')`),
    check(
      'channel_identity_revoke_check',
      sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`,
    ),
  ],
);

/** The bot's state for a conversation (CM-03; plan 4.5), expiring after 30 idle minutes. */
export const botSession = pgTable(
  'bot_session',
  {
    id: id(),
    companyId: companyId(),
    conversationId: uuid().notNull(),
    /** The bot state's name, for queries; the whole session is in `context`. */
    state: text().notNull(),
    context: jsonb().notNull(),
    /** Plan 4.8: the WhatsApp consent question was asked in this conversation. */
    consentAskedAt: ts(),
    lastActivityAt: tsNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('bot_session_company_id_id_key').on(t.companyId, t.id),
    unique('bot_session_conversation_key').on(t.companyId, t.conversationId),
    foreignKey({
      name: 'bot_session_conversation_fk',
      columns: [t.companyId, t.conversationId],
      foreignColumns: [conversation.companyId, conversation.id],
    }),
    check(
      'bot_session_state_check',
      sql`${t.state} in ('menu', 'choose_lease', 'receipts', 'repair', 'handed_over')`,
    ),
  ],
);

/**
 * An email reply address (CM-10): the SHA-256 of the random token in the Reply-To of one email
 * we sent, which finds the conversation when the tenant answers. The token itself is never stored.
 */
export const replyAddress = pgTable(
  'reply_address',
  {
    id: id(),
    companyId: companyId(),
    conversationId: uuid().notNull(),
    /** The email that carried it. */
    messageId: uuid(),
    tokenHash: text().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('reply_address_company_id_id_key').on(t.companyId, t.id),
    uniqueIndex('reply_address_token_key').on(t.tokenHash),
    foreignKey({
      name: 'reply_address_conversation_fk',
      columns: [t.companyId, t.conversationId],
      foreignColumns: [conversation.companyId, conversation.id],
    }),
    foreignKey({
      name: 'reply_address_message_fk',
      columns: [t.companyId, t.messageId],
      foreignColumns: [message.companyId, message.id],
    }),
    check('reply_address_token_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * An email unsubscribe link (CM-09; decision 7; plan 4.8): the SHA-256 of the random token in the
 * link and `List-Unsubscribe` header of one business-initiated email. Opening it withdraws email.
 */
export const unsubscribeToken = pgTable(
  'unsubscribe_token',
  {
    id: id(),
    companyId: companyId(),
    tenantId: uuid().notNull(),
    tenantContactId: uuid(),
    messageId: uuid(),
    tokenHash: text().notNull(),
    /**
     * M6 review (L3): a keyed hash of the email the link went to. When the address on record has
     * changed, the page changes nothing; while it matches, a link past its date still works.
     */
    addressHash: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('unsubscribe_token_company_id_id_key').on(t.companyId, t.id),
    uniqueIndex('unsubscribe_token_hash_key').on(t.tokenHash),
    foreignKey({
      name: 'unsubscribe_token_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    foreignKey({
      name: 'unsubscribe_token_contact_fk',
      columns: [t.companyId, t.tenantId, t.tenantContactId],
      foreignColumns: [tenantContact.companyId, tenantContact.tenantId, tenantContact.id],
    }),
    foreignKey({
      name: 'unsubscribe_token_message_fk',
      columns: [t.companyId, t.messageId],
      foreignColumns: [message.companyId, message.id],
    }),
    check('unsubscribe_token_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * A person's Expo push token on one device (decision 5), tied to the session that registered it
 * and dropped with it. People span companies (TL-12), so this is a person-level table: the send
 * job reads tokens only through a narrow function that returns those of a person who is a tenant
 * of the job's company.
 */
export const pushDevice = pgTable(
  'push_device',
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    sessionId: uuid()
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    token: text().notNull(),
    platform: text().notNull(),
    deviceName: text(),
    createdAt: tsNow(),
    lastSeenAt: tsNow(),
  },
  (t) => [
    uniqueIndex('push_device_token_key').on(t.token),
    index('push_device_person_idx').on(t.personId),
    check('push_device_platform_check', sql`${t.platform} in ('ios', 'android', 'web')`),
    check(
      'push_device_token_check',
      sql`${t.token} ~ '^Expo(nent)?PushToken\\[[A-Za-z0-9_-]{1,200}\\]$'`,
    ),
  ],
);

/** A named group of tenants for broadcasts (CM-08). */
export const tenantGroup = pgTable(
  'tenant_group',
  {
    id: id(),
    companyId: companyId(),
    name: text().notNull(),
    description: text(),
    createdBy: uuid()
      .notNull()
      .references(() => person.id),
    archivedAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('tenant_group_company_id_id_key').on(t.companyId, t.id),
    uniqueIndex('tenant_group_name_key')
      .on(t.companyId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export const tenantGroupMember = pgTable(
  'tenant_group_member',
  {
    companyId: companyId(),
    groupId: uuid().notNull(),
    tenantId: uuid().notNull(),
    addedBy: uuid()
      .notNull()
      .references(() => person.id),
    addedAt: tsNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.groupId, t.tenantId] }),
    foreignKey({
      name: 'tenant_group_member_group_fk',
      columns: [t.companyId, t.groupId],
      foreignColumns: [tenantGroup.companyId, tenantGroup.id],
    }),
    foreignKey({
      name: 'tenant_group_member_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    index('tenant_group_member_tenant_idx').on(t.companyId, t.tenantId),
  ],
);

/**
 * A broadcast (CM-08; plan 4.7): to a property, some of its blocks or a tenant group, limited to
 * current tenants in the sender's scope; one message per recipient.
 */
export const broadcast = pgTable(
  'broadcast',
  {
    id: id(),
    companyId: companyId(),
    audienceKind: text().notNull(),
    propertyId: uuid(),
    /** For `blocks`: blocks of the property (the service checks they are). */
    blockIds: uuid().array(),
    groupId: uuid(),
    /** What the notice is about, for the building-notice template ("water supply"). */
    topic: text().notNull(),
    body: text().notNull(),
    status: text().notNull(),
    audienceCount: integer().notNull(),
    /** Recipients a message was queued for; the rest could not be reached (no consent, no address). */
    queuedCount: integer().notNull(),
    batches: integer().notNull(),
    batchesQueued: integer().notNull().default(0),
    createdBy: uuid()
      .notNull()
      .references(() => person.id),
    /** The preview it was confirmed from (its token's hash): the same confirmation twice is one broadcast. */
    previewTokenHash: text(),
    confirmedAt: tsNow(),
    completedAt: ts(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    unique('broadcast_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'broadcast_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    foreignKey({
      name: 'broadcast_group_fk',
      columns: [t.companyId, t.groupId],
      foreignColumns: [tenantGroup.companyId, tenantGroup.id],
    }),
    index('broadcast_list_idx').on(t.companyId, t.createdAt),
    uniqueIndex('broadcast_preview_key')
      .on(t.companyId, t.previewTokenHash)
      .where(sql`${t.previewTokenHash} is not null`),
    check('broadcast_audience_check', sql`${t.audienceKind} in ('property', 'blocks', 'group')`),
    check(
      'broadcast_audience_fields_check',
      sql`case ${t.audienceKind} when 'property' then ${t.propertyId} is not null and ${t.blockIds} is null and ${t.groupId} is null when 'blocks' then ${t.propertyId} is not null and cardinality(${t.blockIds}) >= 1 and ${t.groupId} is null else ${t.groupId} is not null and ${t.blockIds} is null end`,
    ),
    check('broadcast_status_check', sql`${t.status} in ('sending', 'sent')`),
    check(
      'broadcast_counts_check',
      sql`${t.audienceCount} >= 0 and ${t.queuedCount} >= 0 and ${t.queuedCount} <= ${t.audienceCount} and ${t.batches} >= 0 and ${t.batchesQueued} >= 0 and ${t.batchesQueued} <= ${t.batches}`,
    ),
  ],
);

/**
 * One recipient of a broadcast (CM-08): the message queued for them, or why none was (no consent,
 * no address). Append-only. Delivery stats come from the messages' events.
 */
export const broadcastRecipient = pgTable(
  'broadcast_recipient',
  {
    id: id(),
    companyId: companyId(),
    broadcastId: uuid().notNull(),
    propertyId: uuid().notNull(),
    tenantId: uuid().notNull(),
    messageId: uuid(),
    /** The channel the preview expected; the send job may still fall back to the next. */
    plannedChannel: text(),
    outcome: text().notNull(),
    reason: text(),
    batch: integer().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    unique('broadcast_recipient_company_id_id_key').on(t.companyId, t.id),
    unique('broadcast_recipient_tenant_key').on(t.companyId, t.broadcastId, t.tenantId),
    foreignKey({
      name: 'broadcast_recipient_broadcast_fk',
      columns: [t.companyId, t.broadcastId],
      foreignColumns: [broadcast.companyId, broadcast.id],
    }),
    foreignKey({
      name: 'broadcast_recipient_tenant_fk',
      columns: [t.companyId, t.tenantId],
      foreignColumns: [tenant.companyId, tenant.id],
    }),
    foreignKey({
      name: 'broadcast_recipient_property_fk',
      columns: [t.companyId, t.propertyId],
      foreignColumns: [property.companyId, property.id],
    }),
    foreignKey({
      name: 'broadcast_recipient_message_fk',
      columns: [t.companyId, t.messageId],
      foreignColumns: [message.companyId, message.id],
    }),
    index('broadcast_recipient_batch_idx').on(t.companyId, t.broadcastId, t.batch),
    check('broadcast_recipient_outcome_check', sql`${t.outcome} in ('queued', 'not_sent')`),
    check(
      'broadcast_recipient_message_check',
      sql`case when ${t.outcome} = 'queued' then ${t.messageId} is not null and ${t.reason} is null else ${t.messageId} is null and ${t.reason} is not null end`,
    ),
    check(
      'broadcast_recipient_channel_check',
      sql`${t.plannedChannel} is null or ${t.plannedChannel} in ('push', 'whatsapp', 'sms', 'email')`,
    ),
    check('broadcast_recipient_batch_check', sql`${t.batch} >= 0`),
  ],
);
