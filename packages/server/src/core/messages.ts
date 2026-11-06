import type { Tx } from '@rent/db';
import {
  BUSINESS_CHANNEL_ORDER,
  CONSENT_CHANNELS,
  INBOUND_CHANNELS,
  MESSAGE_PURPOSES,
  redactLinkTokens,
} from '@rent/domain/messaging';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { enqueueOutbox } from './outbox';

/**
 * Queues an outbound message through the outbox (M3 decision 1; ADR-005). Any module calls this
 * inside its own transaction; the messaging module's `messaging.send` job records the message,
 * checks consent, adds the link and sends it, outside any transaction. If the caller's
 * transaction rolls back, the message never existed.
 *
 * It lives in core so lower layers (esign, tenancy) can queue messages without importing the
 * messaging module, which sits above them (architecture section 2).
 */
export const MESSAGE_SEND_JOB = 'messaging.send';

/**
 * M6 (plan 4.4): stored messaging webhooks (provider `messaging.whatsapp`, `messaging.sms`,
 * `messaging.email`) are processed by this job. The inbox relay, which lives with the payments
 * webhooks it was built for, routes by this prefix, so it needs nothing from the messaging module.
 */
export const MESSAGING_INBOUND_JOB = 'messaging.process-inbound';
export const MESSAGING_WEBHOOK_PREFIX = 'messaging.';

/** Where the send job puts the link in the body. Stored as `[link]`, never as a live token. */
export const LINK_PLACEHOLDER = '{{link}}';
export const STORED_LINK = '[link]';

const uuid = z.string().uuid();

export const messageRecipientSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tenant'), tenantId: uuid }).strict(),
  z.object({ type: z.literal('tenant_contact'), tenantId: uuid, contactId: uuid }).strict(),
  z.object({ type: z.literal('staff'), personId: uuid }).strict(),
  z.object({ type: z.literal('signer'), signerId: uuid }).strict(),
  // M4b: an owner in the register, for settlement-account alerts (ADR-008).
  z.object({ type: z.literal('owner'), ownerId: uuid }).strict(),
]);
export type MessageRecipient = z.infer<typeof messageRecipientSchema>;

export const messageRequestSchema = z
  .object({
    /** Chosen by the caller, so it can refer to the message before it is sent. */
    messageId: uuid,
    recipient: messageRecipientSchema,
    purpose: z.enum(MESSAGE_PURPOSES),
    /** The email subject; SMS has none. */
    subject: z.string().trim().min(1).max(200).nullable(),
    /** Plain text. Put {{link}} where the link goes when there is one. */
    body: z.string().min(1).max(4_000),
    /** Made at send time: a signing link or a signed copy (targets a signer), an ID capture link. */
    link: z
      .object({
        purpose: z.enum(['sign', 'signed_copy', 'id_capture', 'pay', 'receipt']),
        targetId: uuid,
      })
      .strict()
      .nullable(),
    /**
     * The channels it may go by. M6: push, WhatsApp, SMS and email, tried in that order (decision
     * 5) among those listed; each needs an address and consent.
     */
    channels: z.array(z.enum(CONSENT_CHANNELS)).min(1).max(CONSENT_CHANNELS.length),
    propertyId: uuid.nullable(),
    /** What the message is about, for timelines: lease, id_check, signing_request. */
    related: z
      .object({ type: z.string().min(1).max(40), id: uuid })
      .strict()
      .nullable(),
    requestedBy: uuid.nullable(),
    // M6 (plan 4.3 and 4.6), optional so earlier callers' requests stay valid.
    /**
     * Values for the WhatsApp template's parameters beyond the landlord, the recipient's name and
     * the link, which the send job fills in (CM-07).
     */
    templateParams: z
      .record(z.string().regex(/^[a-z_]{1,30}$/), z.string().min(1).max(500))
      .optional(),
    /** A stored PDF to send with it: a WhatsApp document, an email attachment (plan 4.3). */
    document: z
      .object({ documentId: uuid, filename: z.string().min(1).max(120) })
      .strict()
      .optional(),
    /**
     * M7 (decision 4; CLAUDE.md section 8): the lease's electronic-service clause names this
     * address, so it is the consent for a legal notice on the one channel listed. An opt-out on the
     * channel still withholds it (decision 5).
     */
    serviceClause: z.boolean().optional(),
    /** A reply in a conversation, on the channel the tenant used (plan 4.6; decision 6). */
    reply: z
      .object({
        conversationId: uuid,
        channel: z.enum(INBOUND_CHANNELS),
        authorType: z.enum(['staff', 'bot', 'system']),
        authorPersonId: uuid.nullable(),
        /** Staff sending the reopen template outside WhatsApp's window (CM-07). */
        template: z.literal('conversation_reopen').nullable(),
        /** The bot's reply buttons or list rows. */
        choices: z
          .array(
            z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(24) }).strict(),
          )
          .max(10)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((m) => !m.link || m.body.includes(LINK_PLACEHOLDER), {
    message: 'A message with a link must say where the link goes, with {{link}}',
  })
  .refine((m) => !m.serviceClause || m.channels.length === 1, {
    message: 'A message sent on the electronic-service clause goes on one channel',
  });
export type MessageRequest = z.infer<typeof messageRequestSchema>;

type Optional =
  'messageId' | 'channels' | 'link' | 'propertyId' | 'related' | 'requestedBy' | 'subject';
export type NewMessage = Omit<MessageRequest, Optional> & Partial<Pick<MessageRequest, Optional>>;

/**
 * The body as it is recorded: the link shown as [link], and any secure-link token the body
 * carries redacted (CLAUDE.md section 9), so the record never holds a live link.
 */
export const storedBody = (body: string): string =>
  redactLinkTokens(body.split(LINK_PLACEHOLDER).join(STORED_LINK));

/** Queues a message in the caller's transaction and returns its id. */
export async function queueMessage(
  tx: Tx,
  companyId: string,
  message: NewMessage,
): Promise<string> {
  const request = messageRequestSchema.parse({
    messageId: message.messageId ?? uuidv7(),
    recipient: message.recipient,
    purpose: message.purpose,
    subject: message.subject ?? null,
    body: message.body,
    link: message.link ?? null,
    // M6: every channel by default, in the business order (decision 5).
    channels: message.channels ?? [...BUSINESS_CHANNEL_ORDER],
    propertyId: message.propertyId ?? null,
    related: message.related ?? null,
    requestedBy: message.requestedBy ?? null,
    ...(message.templateParams ? { templateParams: message.templateParams } : {}),
    ...(message.document ? { document: message.document } : {}),
    ...(message.reply ? { reply: message.reply } : {}),
    ...(message.serviceClause ? { serviceClause: true } : {}),
  });
  await enqueueOutbox(tx, {
    companyId,
    type: MESSAGE_SEND_JOB,
    payload: request as unknown as Record<string, unknown>,
    idempotencyKey: `${MESSAGE_SEND_JOB}:${request.messageId}`,
  });
  return request.messageId;
}

/**
 * M7 (plan 4.6): "deliver to all". One message per channel, queued at the same moment, each held
 * to its own channel so it never falls back to another and each delivery report names the channel
 * that confirmed it (prd-issues 7). `serviceClause` lists the channels whose address the lease's
 * electronic-service clause names. Returns the message ids by channel.
 */
export async function queueMessageOnEachChannel(
  tx: Tx,
  companyId: string,
  message: Omit<NewMessage, 'channels' | 'messageId'>,
  channels: readonly {
    readonly channel: MessageRequest['channels'][number];
    readonly serviceClause: boolean;
  }[],
): Promise<{ readonly channel: MessageRequest['channels'][number]; readonly messageId: string }[]> {
  const out: { channel: MessageRequest['channels'][number]; messageId: string }[] = [];
  for (const c of channels)
    out.push({
      channel: c.channel,
      messageId: await queueMessage(tx, companyId, {
        ...message,
        channels: [c.channel],
        ...(c.serviceClause ? { serviceClause: true } : {}),
      }),
    });
  return out;
}
