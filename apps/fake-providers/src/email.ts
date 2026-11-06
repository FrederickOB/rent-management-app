import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deliverWebhook, invalid, type idGenerator } from './shared';
import type { FakeStore } from './store';

/**
 * Email webhooks in Postmark's shapes (M6 decision 2). Outbound mail itself goes to Mailpit over
 * SMTP; these controls simulate a tenant's reply and Postmark's delivery and bounce reports.
 */
export interface EmailOptions {
  readonly inboundUrl?: string;
  readonly eventsUrl?: string;
}

const inboundSchema = z.object({
  from: z.string().email(),
  to: z.string().email(),
  subject: z.string().max(200).default('Re: your message'),
  text: z.string().min(1).max(10_000),
  /** The reply alone; the text with a quoted thread under it otherwise. */
  quoted: z.string().max(10_000).optional(),
});
const eventSchema = z.object({
  messageId: z.string().min(1),
  recordType: z.enum(['Delivery', 'Bounce']),
  recipient: z.string().email(),
});

export function registerEmail(
  app: FastifyInstance,
  store: FakeStore,
  ids: ReturnType<typeof idGenerator>,
  options: EmailOptions = {},
): void {
  app.post('/email/_test/inbound', async (request, reply) => {
    const parsed = inboundSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { from, to, subject, text, quoted } = parsed.data;
    const id = ids.next('email-in');
    const rawBody = JSON.stringify({
      From: from,
      FromFull: { Email: from, Name: '' },
      To: to,
      ToFull: [{ Email: to, Name: '' }],
      OriginalRecipient: to,
      Subject: subject,
      MessageID: id,
      TextBody: quoted ? `${text}\n\nOn an earlier day, you wrote:\n> ${quoted}` : text,
      StrippedTextReply: text,
      Attachments: [],
    });
    store.inbound.unshift({ id, channel: 'email', from, body: text, at: new Date().toISOString() });
    const delivery = await deliverWebhook(
      store,
      'email',
      'inbound',
      options.inboundUrl,
      rawBody,
      {},
    );
    return reply.send({ messageId: id, rawBody, delivery });
  });

  app.post('/email/_test/event', async (request, reply) => {
    const parsed = eventSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const at = new Date().toISOString();
    const rawBody = JSON.stringify(
      parsed.data.recordType === 'Delivery'
        ? {
            RecordType: 'Delivery',
            MessageID: parsed.data.messageId,
            Recipient: parsed.data.recipient,
            DeliveredAt: at,
          }
        : {
            RecordType: 'Bounce',
            ID: ids.nextNumber(),
            Type: 'HardBounce',
            MessageID: parsed.data.messageId,
            Email: parsed.data.recipient,
            BouncedAt: at,
          },
    );
    const delivery = await deliverWebhook(
      store,
      'email',
      parsed.data.recordType,
      options.eventsUrl,
      rawBody,
      {},
    );
    return reply.send({ rawBody, delivery });
  });
}
