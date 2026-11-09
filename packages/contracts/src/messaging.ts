import { oc } from '@orpc/contract';
import {
  CHANNELS,
  CONSENT_CHANNELS,
  CONSENT_SOURCES,
  CONVERSATION_STATES,
  HANDOVER_REASONS,
  INBOUND_CHANNELS,
  INBOX_VIEWS,
  MESSAGE_PURPOSES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_KEYS,
  TEMPLATE_STATUSES,
} from '@rent/domain/messaging';
import { inboxTag, INTERIM_PLANS, SUBSCRIPTION_TIERS, TIER_FEATURES } from '@rent/domain/settings';
import { z } from 'zod';

/**
 * Messaging and the unified inbox (CM-01 to CM-10; M6 plan sections 4.3 to 4.12). Staff routes
 * need `messaging.*` permissions and, for the inbox, broadcasts and tenant groups, a plan that
 * includes them (decision 9: a Starter company gets 403 `not_on_plan`). Messages are never edited
 * or deleted: no route here changes or removes one. Bodies are as stored, with links shown as
 * `[link]`. Addresses are masked. Times are ISO instants in UTC; show the company's time zone.
 * Amounts are integer minor units in `*Minor` fields.
 *
 * The live inbox is a server-sent event stream, outside the oRPC contract (like webhooks):
 * `GET ${INBOX_STREAM_PATH}` with the staff session cookie; each event's data is an
 * `InboxStreamEvent` (ids only). The client then fetches what changed.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-01');
const minor = z.number().int();
const ok = z.object({ ok: z.literal(true) });
const cursor = z.string().max(200);
const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    /** Pass back as `cursor` for the next page; null at the end. */
    nextCursor: cursor.nullable(),
  });
const download = z.object({ url: z.string(), expiresAt: iso });
const presignedUpload = z.object({
  uploadId: uuid,
  url: z.string().url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: iso,
});
const token = z.string().max(64);
/** The browser behind a links-app call, as apps/links saw it (links.ts). */
const client = z
  .object({ ip: z.string().trim().min(1).max(64), userAgent: z.string().max(500) })
  .strict();

export const INBOX_STREAM_PATH = '/inbox/stream';
/** What a message's status line shows: the latest event, or `received` for an inbound message. */
export const MESSAGE_STATUSES = [
  'received',
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'not_sent',
] as const;
export const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'document', 'sticker'] as const;
export const AUTHOR_TYPES = ['staff', 'bot', 'system', 'tenant', 'contact', 'unknown'] as const;
/** Photos a tenant may send from the app (plan 4.10). */
export const MESSAGE_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MESSAGE_PHOTO_MAX_BYTES = 10_000_000;
export const MESSAGE_BODY_MAX = 4_000;

// Threads ------------------------------------------------------------------------------------

export const messageAttachmentSchema = z.object({
  id: uuid,
  kind: z.enum(ATTACHMENT_KINDS),
  contentType: z.string(),
  sizeBytes: z.number().int().nullable(),
  filename: z.string().nullable(),
  caption: z.string().nullable(),
  /** `rejected`: not copied (type or size), with the reason. Download only `stored` ones. */
  status: z.enum(['stored', 'rejected']),
  rejectReason: z.string().nullable(),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export const threadMessageSchema = z.object({
  id: uuid,
  conversationId: uuid,
  direction: z.enum(['inbound', 'outbound']),
  /** The channel it came or went on; null while an outbound message has not gone yet. */
  channel: z.enum(CHANNELS).nullable(),
  authorType: z.enum(AUTHOR_TYPES),
  /** For people: the staff member's name, "Assistant" for the bot, the tenant's or contact's name. */
  authorName: z.string().nullable(),
  purpose: z.enum(MESSAGE_PURPOSES),
  subject: z.string().nullable(),
  body: z.string(),
  /** The WhatsApp template it went as, outside the 24-hour window (CM-07). */
  templateKey: z.enum(TEMPLATE_KEYS).nullable(),
  status: z.enum(MESSAGE_STATUSES),
  /** Why it failed or was not sent: no_consent, no_address, opted_out, window_closed and the like. */
  statusReason: z.string().nullable(),
  statusAt: iso,
  attachments: z.array(messageAttachmentSchema),
  /** Media the message carried; more than `attachments.length` while copies are still arriving. */
  attachmentCount: z.number().int(),
  /** CM-12 groundwork (decision 13): what the provider charged, when it says. */
  costMinor: minor.nullable(),
  currency: z.string().nullable(),
  createdAt: iso,
});
export type ThreadMessage = z.infer<typeof threadMessageSchema>;

const unitRef = z.object({
  unitId: uuid,
  unitCode: z.string(),
  propertyId: uuid,
  propertyName: z.string(),
});

export const conversationSummarySchema = z.object({
  id: uuid,
  state: z.enum(CONVERSATION_STATES),
  /** Null for triage (an unknown number or address). */
  tenant: z.object({ id: uuid, name: z.string() }).nullable(),
  triage: z
    .object({ channel: z.enum(['whatsapp', 'sms', 'email']), addressMasked: z.string() })
    .nullable(),
  assignee: z.object({ personId: uuid, name: z.string() }).nullable(),
  tags: z.array(z.string()),
  /** Why the bot handed over, when it did ("asked for a person", plan 4.5). */
  handoverReason: z.enum(HANDOVER_REASONS).nullable(),
  /** The units of the tenant's current leases in this company. */
  units: z.array(unitRef),
  lastMessageAt: iso.nullable(),
  /** The start of the newest message, for the list. */
  lastMessagePreview: z.string().nullable(),
  lastInboundChannel: z.enum(CHANNELS).nullable(),
  /** CM-06 and decision 10: when the first staff reply is due; null when none is owed. */
  firstResponseDueAt: iso.nullable(),
  overdue: z.boolean(),
  /** Tenant messages since staff last replied. */
  unansweredCount: z.number().int(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/** One channel the composer can reply on (plan 4.6; CM-07, CM-09). */
export const replyChannelSchema = z.object({
  channel: z.enum(INBOUND_CHANNELS),
  addressMasked: z.string().nullable(),
  /** Consent on the channel; null for in-app, which needs none. */
  consent: z
    .object({
      granted: z.boolean(),
      source: z.enum(CONSENT_SOURCES).nullable(),
      recordedAt: iso.nullable(),
    })
    .nullable(),
  lastInboundAt: iso.nullable(),
  /** WhatsApp only: when the 24-hour window closes; null when it is closed. */
  windowClosesAt: iso.nullable(),
  /**
   * `free_text`: any reply. `template_only`: WhatsApp outside the window, only the reopen
   * template. `unavailable`: no reply can go on this channel now; `reason` says why.
   */
  mode: z.enum(['free_text', 'template_only', 'unavailable']),
  reason: z.enum(['no_address', 'no_consent', 'opted_out', 'window_closed']).nullable(),
});
export type ReplyChannel = z.infer<typeof replyChannelSchema>;

export const conversationDetailSchema = conversationSummarySchema.extend({
  channels: z.array(replyChannelSchema),
  /** The channel the tenant last wrote on; the composer starts there. */
  defaultChannel: z.enum(INBOUND_CHANNELS).nullable(),
  /** The "reopen conversation" template on the company's sending number (CM-07). */
  reopenTemplate: z
    .object({ status: z.enum(TEMPLATE_STATUSES).nullable(), text: z.string() })
    .nullable(),
  /** Triage conversations linked into this one: their messages are in the thread too. */
  mergedFrom: z.array(uuid),
  leases: z.array(
    unitRef.extend({
      leaseId: uuid,
      status: z.string(),
      startDate: isoDate,
      endDate: isoDate.nullable(),
    }),
  ),
  /** What the signed-in person may do here (policy and plan), so screens show only that. */
  can: z.object({
    reply: z.boolean(),
    assign: z.boolean(),
    triage: z.boolean(),
    /** Set the conversation's tags. */
    tag: z.boolean(),
    /** Resolve or reopen it. */
    resolve: z.boolean(),
  }),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const conversationPageSchema = page(conversationSummarySchema);
export const messagePageSchema = page(threadMessageSchema);

/**
 * The live inbox stream's named SSE events: each `event:` line is one of these, and is the same as
 * the data's `kind`. The stream opens with the comment `: ok` and sends a heartbeat comment at
 * least every 25 seconds; it sends no unnamed events.
 */
export const INBOX_STREAM_EVENTS = [
  'conversation',
  'message',
  'message_event',
  'message_attachment',
] as const;

/** What the live inbox stream sends: ids only (plan 4.6). */
export const inboxStreamEventSchema = z.object({
  kind: z.enum(INBOX_STREAM_EVENTS),
  conversationId: uuid,
  messageId: uuid.nullable(),
});
export type InboxStreamEvent = z.infer<typeof inboxStreamEventSchema>;

export const assigneeSchema = z.object({
  personId: uuid,
  name: z.string(),
  role: z.string(),
});

export const unitConversationSchema = z.object({
  leaseId: uuid,
  leaseStatus: z.string(),
  startDate: isoDate,
  endDate: isoDate.nullable(),
  tenant: z.object({ id: uuid, name: z.string() }),
  /** Null when the tenant has never written or been written to. */
  conversationId: uuid.nullable(),
  /** Fetch the thread with `since` set to this: every message since the lease began (CM-05). */
  since: isoDate,
  messageCount: z.number().int(),
  lastMessageAt: iso.nullable(),
});
export type UnitConversation = z.infer<typeof unitConversationSchema>;

export const inboxContract = {
  conversations: oc
    .route({
      method: 'GET',
      path: '/conversations',
      summary:
        'The inbox: mine, unassigned, triage, overdue, the bot, resolved or all, by tag, property or search (CM-05, CM-06)',
    })
    .input(
      z.object({
        view: z.enum(INBOX_VIEWS).default('all'),
        tag: inboxTag.optional(),
        propertyId: uuid.optional(),
        /** A tenant's name or a unit code. */
        q: z.string().trim().max(80).optional(),
        cursor: cursor.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
    )
    .output(conversationPageSchema),
  counts: oc
    .route({
      method: 'GET',
      path: '/inbox/counts',
      summary: 'How many conversations each inbox view holds, for the tabs',
    })
    .output(z.record(z.enum(INBOX_VIEWS), z.number().int())),
  conversation: oc
    .route({ method: 'GET', path: '/conversations/{conversationId}' })
    .input(z.object({ conversationId: uuid }))
    .output(conversationDetailSchema),
  messages: oc
    .route({
      method: 'GET',
      path: '/conversations/{conversationId}/messages',
      summary:
        'The thread, newest first, across every channel; `since` limits it to a lease’s term (CM-05)',
    })
    .input(
      z.object({
        conversationId: uuid,
        since: isoDate.optional(),
        cursor: cursor.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    )
    .output(messagePageSchema),
  reply: oc
    .route({
      method: 'POST',
      path: '/conversations/{conversationId}/replies',
      summary:
        'Reply on a channel. On WhatsApp outside the 24-hour window only `template: "conversation_reopen"` is accepted (CM-07). A repeated `clientMessageId` sends once; with different content it answers 422 `IDEMPOTENCY_KEY_REUSED`. A resolved conversation answers 409 `CONVERSATION_RESOLVED`: reopen it first.',
    })
    .input(
      z.object({
        conversationId: uuid,
        /** Chosen by the client, so a retried send makes one message. */
        clientMessageId: uuid,
        channel: z.enum(INBOUND_CHANNELS),
        /** Required for free text; ignored for the reopen template. */
        body: z.string().trim().min(1).max(MESSAGE_BODY_MAX).optional(),
        /** Email only. */
        subject: z.string().trim().max(200).optional(),
        template: z.literal('conversation_reopen').optional(),
      }),
    )
    .output(threadMessageSchema),
  assignees: oc
    .route({
      method: 'GET',
      path: '/conversations/{conversationId}/assignees',
      summary: 'Staff this conversation may be assigned to: those whose scope includes the tenant',
    })
    .input(z.object({ conversationId: uuid }))
    .output(z.array(assigneeSchema)),
  assign: oc
    .route({
      method: 'POST',
      path: '/conversations/{conversationId}/assign',
      summary: 'Assign to a staff member in scope, or unassign with null (CM-06); audited',
    })
    .input(z.object({ conversationId: uuid, personId: uuid.nullable() }))
    .output(conversationSummarySchema),
  setTags: oc
    .route({
      method: 'PUT',
      path: '/conversations/{conversationId}/tags',
      summary: 'The conversation’s tags, from the company’s list (CM-06); audited',
    })
    .input(z.object({ conversationId: uuid, tags: z.array(inboxTag).max(30) }))
    .output(conversationSummarySchema),
  resolve: oc
    .route({ method: 'POST', path: '/conversations/{conversationId}/resolve' })
    .input(z.object({ conversationId: uuid }))
    .output(conversationSummarySchema),
  reopen: oc
    .route({ method: 'POST', path: '/conversations/{conversationId}/reopen' })
    .input(z.object({ conversationId: uuid }))
    .output(conversationSummarySchema),
  linkTriage: oc
    .route({
      method: 'POST',
      path: '/conversations/{conversationId}/link',
      summary:
        'Link a triage conversation to a tenant or one of their contacts; later messages from that number or address follow (CM-02). Recorded and audited. Answers the tenant’s conversation.',
    })
    .input(
      z.object({ conversationId: uuid, tenantId: uuid, contactId: uuid.nullable().optional() }),
    )
    .output(conversationSummarySchema),
  attachmentDownload: oc
    .route({
      method: 'GET',
      path: '/conversations/{conversationId}/attachments/{attachmentId}/download',
      summary: 'A short-lived link to an attachment, after a policy check',
    })
    .input(z.object({ conversationId: uuid, attachmentId: uuid }))
    .output(download),
  tenantConversation: oc
    .route({
      method: 'GET',
      path: '/tenants/{tenantId}/conversation',
      summary: 'The tenant’s conversation, if there is one yet (CM-05)',
    })
    .input(z.object({ tenantId: uuid }))
    .output(z.object({ conversation: conversationSummarySchema.nullable() })),
  startConversation: oc
    .route({
      method: 'POST',
      path: '/tenants/{tenantId}/conversation',
      summary:
        'Open the tenant’s conversation for a staff message; answers the existing one if any',
    })
    .input(z.object({ tenantId: uuid }))
    .output(conversationSummarySchema),
  unitConversations: oc
    .route({
      method: 'GET',
      path: '/units/{unitId}/conversations',
      summary:
        'Every conversation with the unit’s tenants since each lease began, across channels (CM-05 acceptance)',
    })
    .input(z.object({ unitId: uuid }))
    .output(z.array(unitConversationSchema)),
};

// Consent across channels (CM-09) -----------------------------------------------------------

export const channelConsentSchema = z.object({
  channel: z.enum(CONSENT_CHANNELS),
  granted: z.boolean(),
  /** How the latest event came: staff, a WhatsApp YES, STOP or START, the app, the unsubscribe link. */
  source: z.enum(CONSENT_SOURCES).nullable(),
  recordedAt: iso.nullable(),
  /** Whether there is an address for it: a phone, an email, or for push a registered device. */
  reachable: z.boolean(),
  /**
   * Why the latest event happened when the system did it for a reason: `address_changed` is the
   * reset when the phone or email changed (decision 8), not a withdrawal by staff. Null otherwise.
   * The API always sends it; optional so earlier fixtures stay valid (M6 review, C3).
   */
  reason: z.enum(['address_changed']).nullable().optional(),
});

export const messagingConsentSchema = z.object({
  tenantId: uuid,
  subjects: z.array(
    z.object({
      /** Null: the tenant themselves. */
      contactId: uuid.nullable(),
      name: z.string(),
      /** `tenant`, or the contact's kind (guarantor, signatory, finance…). */
      kind: z.string(),
      channels: z.array(channelConsentSchema),
    }),
  ),
});
export type MessagingConsent = z.infer<typeof messagingConsentSchema>;

/**
 * Consent on every channel, WhatsApp and push included (CM-09; plan 4.8). The M3 route
 * `POST /tenants/{tenantId}/consent` keeps its SMS-and-email shape for the forms built on it.
 */
export const messagingConsentContract = {
  get: oc
    .route({ method: 'GET', path: '/tenants/{tenantId}/messaging-consent' })
    .input(z.object({ tenantId: uuid }))
    .output(messagingConsentSchema),
  record: oc
    .route({
      method: 'POST',
      path: '/tenants/{tenantId}/messaging-consent',
      summary:
        'Record that the tenant or a contact agreed to, or no longer wants, messages on a channel (CM-09). A changed phone or email starts with none (decision 8).',
    })
    .input(
      z.object({
        tenantId: uuid,
        contactId: uuid.nullable().optional(),
        channel: z.enum(CONSENT_CHANNELS),
        action: z.enum(['grant', 'withdraw']),
      }),
    )
    .output(messagingConsentSchema),
};

// Broadcasts (CM-08) -----------------------------------------------------------------------

export const broadcastAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('property'), propertyId: uuid }).strict(),
  z
    .object({ kind: z.literal('blocks'), propertyId: uuid, blockIds: z.array(uuid).min(1).max(50) })
    .strict(),
  z.object({ kind: z.literal('group'), groupId: uuid }).strict(),
]);
export type BroadcastAudience = z.infer<typeof broadcastAudienceSchema>;

const broadcastContent = {
  /** What it is about, for the WhatsApp building-notice template: "water supply", "fumigation". */
  topic: z.string().trim().min(2).max(60),
  body: z.string().trim().min(1).max(1_000),
};

const channelCounts = z.object({
  push: z.number().int(),
  whatsapp: z.number().int(),
  sms: z.number().int(),
  email: z.number().int(),
});

export const broadcastPreviewSchema = z.object({
  /** Current tenants of the audience in the sender's scope. */
  audienceCount: z.number().int(),
  reachableCount: z.number().int(),
  /** Who would get it on which channel first (the send can still fall back to the next). */
  byChannel: channelCounts,
  /** Who cannot be reached, and why: no consent on any channel, or no address. */
  unreachable: z.array(
    z.object({
      tenantId: uuid,
      name: z.string(),
      unitCode: z.string().nullable(),
      reason: z.enum(['no_consent', 'no_address', 'opted_out']),
    }),
  ),
  /** Send it back with `create`; if the audience changed meanwhile, `create` answers 409. */
  previewToken: z.string(),
});
export type BroadcastPreview = z.infer<typeof broadcastPreviewSchema>;

const statusCounts = z.object({
  queued: z.number().int(),
  sent: z.number().int(),
  delivered: z.number().int(),
  read: z.number().int(),
  failed: z.number().int(),
  notSent: z.number().int(),
});

export const broadcastSchema = z.object({
  id: uuid,
  audience: broadcastAudienceSchema,
  /** For people: the property, blocks or group. */
  audienceLabel: z.string(),
  topic: z.string(),
  body: z.string(),
  status: z.enum(['sending', 'sent']),
  audienceCount: z.number().int(),
  queuedCount: z.number().int(),
  createdBy: z.object({ personId: uuid, name: z.string() }),
  confirmedAt: iso,
  completedAt: iso.nullable(),
  /** Delivery stats (CM-08): totals, and per channel. Queued + … + not sent = the audience. */
  stats: statusCounts.extend({
    byChannel: z.object({
      push: statusCounts,
      whatsapp: statusCounts,
      sms: statusCounts,
      email: statusCounts,
    }),
  }),
});
export type Broadcast = z.infer<typeof broadcastSchema>;

export const broadcastDetailSchema = broadcastSchema.extend({
  recipients: z.array(
    z.object({
      tenantId: uuid,
      name: z.string(),
      unitCode: z.string().nullable(),
      channel: z.enum(CONSENT_CHANNELS).nullable(),
      status: z.enum(MESSAGE_STATUSES),
      reason: z.string().nullable(),
    }),
  ),
});
export type BroadcastDetail = z.infer<typeof broadcastDetailSchema>;

export const broadcastsContract = {
  preview: oc
    .route({
      method: 'POST',
      path: '/broadcasts/preview',
      summary:
        'Who a broadcast reaches, on which channel, and who it cannot (CM-08). Sends nothing.',
    })
    .input(z.object({ audience: broadcastAudienceSchema, ...broadcastContent }))
    .output(broadcastPreviewSchema),
  create: oc
    .route({
      method: 'POST',
      path: '/broadcasts',
      summary:
        'Confirm and send: one message per reachable tenant, in throttled batches (CM-08). 409 `audience_changed` when the preview is out of date. No approval step.',
    })
    .input(
      z.object({
        audience: broadcastAudienceSchema,
        ...broadcastContent,
        previewToken: z.string().min(1).max(200),
      }),
    )
    .output(broadcastSchema),
  list: oc
    .route({ method: 'GET', path: '/broadcasts', summary: 'Broadcasts, newest first, with stats' })
    .input(
      z.object({
        propertyId: uuid.optional(),
        cursor: cursor.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
    )
    .output(page(broadcastSchema)),
  get: oc
    .route({ method: 'GET', path: '/broadcasts/{broadcastId}' })
    .input(z.object({ broadcastId: uuid }))
    .output(broadcastDetailSchema),
};

// Tenant groups (CM-08) ---------------------------------------------------------------------

export const tenantGroupSchema = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  /** Members the signed-in person can see (scope applies). */
  memberCount: z.number().int(),
  archivedAt: iso.nullable(),
  createdAt: iso,
});
export type TenantGroup = z.infer<typeof tenantGroupSchema>;

export const tenantGroupMemberSchema = z.object({
  tenantId: uuid,
  name: z.string(),
  units: z.array(unitRef),
  addedAt: iso,
});

const groupFields = {
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).nullable().optional(),
};

export const tenantGroupsContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/tenant-groups',
      summary:
        'Groups by name. `archived=true` lists only archived groups; without it (or false), only active ones.',
    })
    .input(z.object({ archived: z.stringbool().optional() }))
    .output(z.array(tenantGroupSchema)),
  get: oc
    .route({
      method: 'GET',
      path: '/tenant-groups/{groupId}',
      summary: 'One group, archived or not',
    })
    .input(z.object({ groupId: uuid }))
    .output(tenantGroupSchema),
  create: oc
    .route({ method: 'POST', path: '/tenant-groups' })
    .input(z.object(groupFields))
    .output(tenantGroupSchema),
  update: oc
    .route({ method: 'PATCH', path: '/tenant-groups/{groupId}' })
    .input(z.object({ groupId: uuid, ...groupFields, name: groupFields.name.optional() }))
    .output(tenantGroupSchema),
  archive: oc
    .route({ method: 'POST', path: '/tenant-groups/{groupId}/archive' })
    .input(z.object({ groupId: uuid }))
    .output(tenantGroupSchema),
  members: oc
    .route({ method: 'GET', path: '/tenant-groups/{groupId}/members' })
    .input(z.object({ groupId: uuid }))
    .output(z.array(tenantGroupMemberSchema)),
  addMembers: oc
    .route({ method: 'POST', path: '/tenant-groups/{groupId}/members' })
    .input(z.object({ groupId: uuid, tenantIds: z.array(uuid).min(1).max(500) }))
    .output(tenantGroupSchema),
  removeMembers: oc
    .route({ method: 'POST', path: '/tenant-groups/{groupId}/members/remove' })
    .input(z.object({ groupId: uuid, tenantIds: z.array(uuid).min(1).max(500) }))
    .output(tenantGroupSchema),
};

// Templates (CM-07) -------------------------------------------------------------------------

export const whatsappNumberRefSchema = z.object({
  kind: z.enum(['shared', 'company']),
  displayPhone: z.string(),
  displayName: z.string(),
});

export const messageTemplateSchema = z.object({
  key: z.enum(TEMPLATE_KEYS),
  version: z.number().int(),
  whatsappName: z.string(),
  category: z.enum(TEMPLATE_CATEGORIES),
  language: z.string(),
  /** Our text, with `{{1}}`, `{{2}}` … for its parameters; the first is the landlord's name. */
  body: z.string(),
  parameters: z.array(z.string()),
  /** Its approval on each number the company may send from; the sending one first. */
  statuses: z.array(
    z.object({
      number: whatsappNumberRefSchema,
      sending: z.boolean(),
      /** Null: not yet submitted to Meta for that number. */
      status: z.enum(TEMPLATE_STATUSES).nullable(),
      reason: z.string().nullable(),
      checkedAt: iso.nullable(),
    }),
  ),
});
export type MessageTemplate = z.infer<typeof messageTemplateSchema>;

export const templatesContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/message-templates',
      summary: 'Each template’s text and its approval on the company’s WhatsApp numbers (CM-07)',
    })
    .output(z.array(messageTemplateSchema)),
};

// Messaging settings (CM-06; decisions 3, 9 and 10) --------------------------------------------

export const messagingSettingsSchema = z.object({
  /** Clock minutes from a tenant's message to the first staff reply (decision 10). */
  firstResponseMinutes: z.number().int(),
  /** The tags staff may put on conversations. */
  tags: z.array(z.string()),
  plan: z.enum(SUBSCRIPTION_TIERS),
  features: z.array(z.enum(TIER_FEATURES)),
  /** The number the company sends WhatsApp from: its own, or the shared platform number. */
  whatsappNumber: whatsappNumberRefSchema.nullable(),
});
export type MessagingSettings = z.infer<typeof messagingSettingsSchema>;

export const messagingSettingsContract = {
  get: oc.route({ method: 'GET', path: '/messaging/settings' }).output(messagingSettingsSchema),
  update: oc
    .route({
      method: 'PATCH',
      path: '/messaging/settings',
      summary: 'The response target and the conversation tags (company admins)',
    })
    .input(
      z.object({
        firstResponseMinutes: z
          .number()
          .int()
          .min(15)
          .max(7 * 24 * 60)
          .optional(),
        tags: z.array(inboxTag).min(1).max(30).optional(),
      }),
    )
    .output(messagingSettingsSchema),
};

// Platform admin (decisions 3 and 9) -----------------------------------------------------------

export const whatsappNumberSchema = z.object({
  id: uuid,
  phoneNumberId: z.string(),
  wabaId: z.string(),
  displayPhone: z.string(),
  displayName: z.string(),
  kind: z.enum(['shared', 'company']),
  company: z.object({ id: uuid, name: z.string() }).nullable(),
  status: z.enum(['active', 'retired']),
  createdAt: iso,
});
export type WhatsAppNumber = z.infer<typeof whatsappNumberSchema>;

export const companyPlanSchema = z.object({
  companyId: uuid,
  displayName: z.string(),
  kind: z.enum(['landlord', 'agency']),
  status: z.string(),
  plan: z.enum(SUBSCRIPTION_TIERS),
});
export type CompanyPlan = z.infer<typeof companyPlanSchema>;

export const platformMessagingContract = {
  whatsappNumbers: oc
    .route({ method: 'GET', path: '/platform/whatsapp-numbers' })
    .output(z.array(whatsappNumberSchema)),
  registerWhatsappNumber: oc
    .route({
      method: 'POST',
      path: '/platform/whatsapp-numbers',
      summary:
        'Register the shared number, or a company’s own (its WhatsApp account shared with the platform’s business, decision 3)',
    })
    .input(
      z
        .object({
          phoneNumberId: z
            .string()
            .trim()
            .regex(/^\d{5,30}$/),
          wabaId: z
            .string()
            .trim()
            .regex(/^\d{5,30}$/),
          displayPhone: z
            .string()
            .trim()
            .regex(/^\+[1-9]\d{6,14}$/, 'Use E.164, such as +233…'),
          displayName: z.string().trim().min(2).max(60),
          kind: z.enum(['shared', 'company']),
          companyId: uuid.nullable(),
        })
        .refine((n) => (n.kind === 'company') === (n.companyId !== null), {
          message: 'A company number names its company; the shared number names none',
        }),
    )
    .output(whatsappNumberSchema),
  retireWhatsappNumber: oc
    .route({ method: 'POST', path: '/platform/whatsapp-numbers/{numberId}/retire' })
    .input(z.object({ numberId: uuid }))
    .output(whatsappNumberSchema),
  companyPlans: oc
    .route({
      method: 'GET',
      path: '/platform/company-plans',
      summary: 'Each company’s interim plan (decision 9; M10 replaces it)',
    })
    .output(z.array(companyPlanSchema)),
  setCompanyPlan: oc
    .route({ method: 'PUT', path: '/platform/companies/{companyId}/plan' })
    .input(z.object({ companyId: uuid, plan: z.enum(INTERIM_PLANS) }))
    .output(companyPlanSchema),
};

// The tenant app (plan 4.10) ---------------------------------------------------------------

export const tenantConversationSchema = z.object({
  /** One conversation per landlord. */
  companyId: uuid,
  landlordName: z.string(),
  /** Null until the first message either way. */
  conversationId: uuid.nullable(),
  lastMessageAt: iso.nullable(),
  lastMessagePreview: z.string().nullable(),
  /** Messages from the landlord since the tenant last opened the conversation in the app. */
  unreadCount: z.number().int(),
});
export type TenantConversation = z.infer<typeof tenantConversationSchema>;

/** A message as the tenant sees it: no staff names beyond the landlord's, no costs, no reasons. */
export const tenantMessageSchema = z.object({
  id: uuid,
  direction: z.enum(['inbound', 'outbound']),
  /** Inbound: written by this tenant (or their contact); outbound: from the landlord. */
  fromLandlord: z.boolean(),
  channel: z.enum(CHANNELS).nullable(),
  body: z.string(),
  attachments: z.array(messageAttachmentSchema),
  attachmentCount: z.number().int(),
  createdAt: iso,
  /**
   * The tenant's own in-app messages: the `clientMessageId` it was sent with; otherwise null.
   * The API always sends this and `deliveryStatus`; they are optional so earlier clients and
   * fixtures stay valid (added in M6 phase 2).
   */
  clientMessageId: uuid.nullable().optional(),
  /**
   * The tenant's own messages, on any channel: `sent` once stored, `read` once the landlord's side
   * (staff or the assistant) has replied after it. `delivered` is reserved; nothing reports it
   * yet. Null for the landlord's messages.
   */
  deliveryStatus: z.enum(['sent', 'delivered', 'read']).nullable().optional(),
});
export type TenantMessage = z.infer<typeof tenantMessageSchema>;

/** The screens a push notification may open in the tenant app. */
export const PUSH_DATA_SCREENS = [
  'receipt',
  'payments',
  'messages',
  'to_sign',
  'tenancy',
  'home',
] as const;

/**
 * The `data` every push notification carries (decision 5). The app opens `screen` for `companyId`
 * (and `leaseId` where one applies); it never navigates to a path or URL from it. The title and
 * body never carry an amount or an address.
 */
export const pushDataSchema = z.object({
  screen: z.enum(PUSH_DATA_SCREENS),
  companyId: uuid.optional(),
  leaseId: uuid.optional(),
});
export type PushData = z.infer<typeof pushDataSchema>;

export const pushConsentSchema = z.array(
  z.object({ companyId: uuid, landlordName: z.string(), granted: z.boolean() }),
);

export const tenantMessagingContract = {
  conversations: oc
    .route({
      method: 'GET',
      path: '/me/conversations',
      summary: 'The signed-in tenant’s conversation with each landlord (CM-05)',
    })
    .output(z.array(tenantConversationSchema)),
  messages: oc
    .route({
      method: 'GET',
      path: '/me/conversations/{companyId}/messages',
      summary:
        'The conversation with one landlord, newest first. Opening it marks the landlord’s messages read (`read` events on the in-app channel), which `unreadCount` counts',
    })
    .input(
      z.object({
        companyId: uuid,
        cursor: cursor.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    )
    .output(page(tenantMessageSchema)),
  send: oc
    .route({
      method: 'POST',
      path: '/me/conversations/{companyId}/messages',
      summary:
        'Write to a landlord in the app, with photos uploaded first. A repeated `clientMessageId` makes one message; with a different body or photos it answers 422 `IDEMPOTENCY_KEY_REUSED`.',
    })
    .input(
      z
        .object({
          companyId: uuid,
          clientMessageId: uuid,
          body: z.string().trim().max(MESSAGE_BODY_MAX).default(''),
          /**
           * Photo uploads from `createPhotoUpload` (no confirm step): each is checked against its
           * stored type and size, and must be this person's, for this conversation.
           */
          uploadIds: z.array(uuid).max(5).default([]),
        })
        .refine((m) => m.body.length > 0 || m.uploadIds.length > 0, {
          message: 'Write a message or add a photo',
        }),
    )
    .output(tenantMessageSchema),
  attachmentDownload: oc
    .route({
      method: 'GET',
      path: '/me/conversations/{companyId}/messages/{messageId}/attachments/{attachmentId}/download',
      summary:
        'A short-lived link to an attachment in the signed-in person’s own conversation with this landlord (TL-12)',
    })
    .input(z.object({ companyId: uuid, messageId: uuid, attachmentId: uuid }))
    .output(download),
  createPhotoUpload: oc
    .route({
      method: 'POST',
      path: '/me/conversations/{companyId}/uploads',
      summary: 'A presigned upload for a photo to send in the conversation',
    })
    .input(
      z.object({
        companyId: uuid,
        contentType: z.enum(MESSAGE_PHOTO_CONTENT_TYPES),
        sizeBytes: z.number().int().positive().max(MESSAGE_PHOTO_MAX_BYTES),
      }),
    )
    .output(presignedUpload),
  registerPushDevice: oc
    .route({
      method: 'POST',
      path: '/me/push-devices',
      summary:
        'Register this device’s Expo push token for the signed-in session; dropped when the session is revoked (decision 5)',
    })
    .input(
      z.object({
        token: z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/),
        platform: z.enum(['ios', 'android', 'web']),
        deviceName: z.string().trim().max(80).nullable().optional(),
      }),
    )
    .output(z.object({ deviceId: uuid })),
  unregisterPushDevice: oc
    .route({
      method: 'POST',
      path: '/me/push-devices/unregister',
      summary: 'Remove this device’s push token (sign-out, or notifications turned off)',
    })
    .input(z.object({ token: z.string().max(220) }))
    .output(ok),
  pushConsent: oc.route({ method: 'GET', path: '/me/push-consent' }).output(pushConsentSchema),
  setPushConsent: oc
    .route({
      method: 'PUT',
      path: '/me/push-consent',
      summary:
        'The app’s notification toggle, after the phone’s own permission prompt: recorded as consent from the app, for one landlord or (no companyId) all (decision 5)',
    })
    .input(z.object({ granted: z.boolean(), companyId: uuid.optional() }))
    .output(pushConsentSchema),
};

// The email unsubscribe page, apps/links /u/[token] (CM-09; decision 7) --------------------------

/**
 * `address_changed` (M6 review, C6): the token was sent to an email that is no longer the one on
 * record. A neutral screen: nothing changes, and neither address is shown (`emailMasked` null).
 */
export const UNSUBSCRIBE_SCREENS = [
  'confirm',
  'done',
  'expired',
  'invalid',
  'address_changed',
] as const;

export const unsubscribePageSchema = z.object({
  screen: z.enum(UNSUBSCRIBE_SCREENS),
  /** Null for `invalid`: a token that matches nothing names nobody. */
  landlordName: z.string().nullable(),
  /** The address that would stop; null for `invalid` and `address_changed`. */
  emailMasked: z.string().nullable(),
});
export type UnsubscribePage = z.infer<typeof unsubscribePageSchema>;

/**
 * Called server to server by apps/links with the links key, like the signing and pay pages
 * (links.ts). Opening shows what would stop; confirming (the page's button, or a mail client's
 * one-click `List-Unsubscribe-Post`) withdraws email consent and is idempotent. A link past its
 * date still works while the address it went to is the one on record (opt-outs are always
 * honoured); `expired` is left for links that cannot be checked that way. `address_changed`
 * answers both calls, and changes nothing. `client` is the browser's, for the rate limit.
 */
export const unsubscribeLinksContract = {
  open: oc
    .route({ method: 'POST', path: '/links/unsubscribe/open' })
    .input(z.object({ token, client }).strict())
    .output(unsubscribePageSchema),
  confirm: oc
    .route({ method: 'POST', path: '/links/unsubscribe/confirm' })
    .input(z.object({ token, client }).strict())
    .output(unsubscribePageSchema),
};
