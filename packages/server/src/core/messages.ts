import type { Tx } from '@rent/db';
import { MESSAGE_CHANNELS, MESSAGE_PURPOSES, redactLinkTokens } from '@rent/domain/messaging';
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
    /** The channels it may go by, in order; the consented ones are tried in this order. */
    channels: z.array(z.enum(MESSAGE_CHANNELS)).min(1).max(MESSAGE_CHANNELS.length),
    propertyId: uuid.nullable(),
    /** What the message is about, for timelines: lease, id_check, signing_request. */
    related: z
      .object({ type: z.string().min(1).max(40), id: uuid })
      .strict()
      .nullable(),
    requestedBy: uuid.nullable(),
  })
  .strict()
  .refine((m) => !m.link || m.body.includes(LINK_PLACEHOLDER), {
    message: 'A message with a link must say where the link goes, with {{link}}',
  });
export type MessageRequest = z.infer<typeof messageRequestSchema>;

export type NewMessage = Omit<
  MessageRequest,
  'messageId' | 'channels' | 'link' | 'propertyId' | 'related' | 'requestedBy' | 'subject'
> &
  Partial<
    Pick<
      MessageRequest,
      'messageId' | 'channels' | 'link' | 'propertyId' | 'related' | 'requestedBy' | 'subject'
    >
  >;

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
    channels: message.channels ?? ['sms', 'email'],
    propertyId: message.propertyId ?? null,
    related: message.related ?? null,
    requestedBy: message.requestedBy ?? null,
  });
  await enqueueOutbox(tx, {
    companyId,
    type: MESSAGE_SEND_JOB,
    payload: request as unknown as Record<string, unknown>,
    idempotencyKey: `${MESSAGE_SEND_JOB}:${request.messageId}`,
  });
  return request.messageId;
}
