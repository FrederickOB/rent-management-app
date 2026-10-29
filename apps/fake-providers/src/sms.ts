import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { e164, invalid, type idGenerator } from './shared';
import type { Captured, FakeStore } from './store';

const smsSchema = z.object({
  to: e164,
  body: z.string().min(1).max(1600),
  senderId: z.string().max(11).optional(),
  reference: z.string().max(200).optional(),
});

/** A generic SMS gateway; the real gateway is chosen in M6. */
export function registerSms(
  app: FastifyInstance,
  store: FakeStore,
  ids: ReturnType<typeof idGenerator>,
): void {
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
    return reply.code(201).send({ id: message.id, status: 'sent' });
  });
}
