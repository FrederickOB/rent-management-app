import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deliverWebhook, e164, invalid, type idGenerator } from './shared';
import type { Captured, FakeStore } from './store';

export interface SmsOptions {
  /** Where simulated replies go, in Hubtel's inbound shape (with our secret in the URL). */
  readonly inboundUrl?: string;
  /** Where simulated delivery reports go, in Hubtel's callback shape. */
  readonly statusUrl?: string;
}

const inboundSchema = z.object({ from: e164, text: z.string().min(1).max(1600) });
const statusSchema = z.object({
  messageId: z.string().min(1),
  status: z.enum(['Delivered', 'Undelivered', 'Rejected', 'Expired']),
});

const smsSchema = z.object({
  to: e164,
  body: z.string().min(1).max(1600),
  senderId: z.string().max(11).optional(),
  reference: z.string().max(200).optional(),
});

/** An SMS gateway; replies and delivery reports are simulated in Hubtel's shapes (M6 decision 1). */
export function registerSms(
  app: FastifyInstance,
  store: FakeStore,
  ids: ReturnType<typeof idGenerator>,
  options: SmsOptions = {},
): void {
  // Test controls: a person replies by SMS, or the gateway reports a delivery.
  app.post('/sms/_test/inbound', async (request, reply) => {
    const parsed = inboundSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const id = ids.next('sms-in');
    const rawBody = JSON.stringify({
      From: parsed.data.from.slice(1),
      To: '4040',
      Content: parsed.data.text,
      MessageId: id,
      Date: new Date().toISOString(),
    });
    store.inbound.unshift({
      id,
      channel: 'sms',
      from: parsed.data.from,
      body: parsed.data.text,
      at: new Date().toISOString(),
    });
    const delivery = await deliverWebhook(store, 'sms', 'inbound', options.inboundUrl, rawBody, {});
    return reply.send({ messageId: id, rawBody, delivery });
  });

  app.post('/sms/_test/status', async (request, reply) => {
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const message = store.messages.find(
      (m) => m.channel === 'sms' && m.id === parsed.data.messageId,
    );
    if (!message) return reply.code(404).send({ error: 'message not found' });
    const rawBody = JSON.stringify({
      rate: 0.0246,
      messageId: message.id,
      status: parsed.data.status,
      updateTime: new Date().toISOString(),
      to: message.to.slice(1),
    });
    const delivery = await deliverWebhook(store, 'sms', 'status', options.statusUrl, rawBody, {});
    return reply.send({ rawBody, delivery });
  });

  app.post('/sms/messages', async (request, reply) => {
    const parsed = smsSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const message: Captured = {
      id: ids.next('sms'),
      channel: 'sms',
      to: parsed.data.to,
      body: parsed.data.body,
      at: new Date().toISOString(),
      meta: { senderId: parsed.data.senderId, reference: parsed.data.reference },
    };
    store.messages.unshift(message);
    return reply.code(201).send({ id: message.id, status: 'sent', rate: 0.0246 });
  });
}
