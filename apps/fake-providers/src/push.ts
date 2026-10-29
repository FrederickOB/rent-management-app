import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, type idGenerator } from './shared';
import type { Captured, FakeStore } from './store';

const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[^\]\s]+\]$/;
const PAYLOAD_LIMIT_BYTES = 4096;

const messageSchema = z.object({
  to: z.string().min(1).max(256),
  title: z.string().max(4096),
  body: z.string().max(8192),
  data: z.record(z.string(), z.string()).optional(),
});
// Expo takes at most 100 notifications per request and 1000 receipt ids.
const sendSchema = z.array(messageSchema).min(1).max(100);
const receiptsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(1000) });

const deviceNotRegistered = (to: string) => ({
  status: 'error',
  message: `${JSON.stringify(to)} is not a registered push notification recipient`,
  details: { error: 'DeviceNotRegistered' },
});

/**
 * Push, shaped like Expo's push API. A malformed token is refused at once; a token containing
 * "unregistered" is accepted, and its receipt reports DeviceNotRegistered, as for an uninstalled app.
 */
export function registerPush(
  app: FastifyInstance,
  store: FakeStore,
  ids: ReturnType<typeof idGenerator>,
): void {
  app.post('/push/send', async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const data = parsed.data.map((message) => {
      if (!EXPO_TOKEN.test(message.to)) return deviceNotRegistered(message.to);
      const payload = JSON.stringify({
        title: message.title,
        body: message.body,
        data: message.data ?? {},
      });
      if (Buffer.byteLength(payload) > PAYLOAD_LIMIT_BYTES) {
        return { status: 'error', message: 'Message too big', details: { error: 'MessageTooBig' } };
      }
      const ticketId = ids.next('ticket');
      const captured: Captured = {
        id: ticketId,
        channel: 'push',
        to: message.to,
        body: message.body,
        at: new Date().toISOString(),
        meta: { title: message.title, data: message.data },
      };
      store.messages.unshift(captured);
      store.pushReceipts.set(
        ticketId,
        message.to.toLowerCase().includes('unregistered')
          ? { status: 'error', error: 'DeviceNotRegistered' }
          : { status: 'ok' },
      );
      return { status: 'ok', id: ticketId };
    });
    return reply.send({ data });
  });

  app.post('/push/getReceipts', async (request, reply) => {
    const parsed = receiptsSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const receipts: [string, unknown][] = [];
    for (const id of parsed.data.ids) {
      const receipt = store.pushReceipts.get(id);
      // Like Expo, receipts it does not have (yet) are simply left out.
      if (!receipt) continue;
      receipts.push([
        id,
        receipt.status === 'ok'
          ? { status: 'ok' }
          : {
              status: 'error',
              message: 'The device cannot receive notifications',
              details: { error: receipt.error },
            },
      ]);
    }
    return reply.send({ data: Object.fromEntries(receipts) });
  });
}
