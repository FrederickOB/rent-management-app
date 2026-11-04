import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerAddressLookup } from './address-lookup';
import { registerIdentity } from './identity';
import { renderInbox } from './inbox';
import { registerPayments } from './payments';
import { registerPush } from './push';
import { idGenerator } from './shared';
import { registerSms } from './sms';
import { createStore, resetStore, type FakeStore } from './store';
import { registerWhatsApp } from './whatsapp';

export type { Captured, FakeStore } from './store';
export { createStore } from './store';

/**
 * Local stand-ins for every external provider (CLAUDE.md section 8). Everything is kept in
 * memory and lost on restart. Never deployed: main.ts refuses to start in production.
 */
export interface FakeProvidersOptions {
  /** Paystack-style secret key: authenticates payment API calls and signs payment webhooks. */
  readonly paymentsSecretKey?: string;
  /** Where to POST `charge.success` webhooks; none are sent when unset. */
  readonly paymentsWebhookUrl?: string;
  /** Meta-style app secret that signs WhatsApp webhooks. */
  readonly whatsappAppSecret?: string;
  readonly whatsappWebhookUrl?: string;
  readonly identityWebhookUrl?: string;
}

/** Dev-only defaults; the platform's dev config must use the same values to verify webhooks. */
export const DEFAULT_PAYMENTS_SECRET_KEY = 'sk_test_fake_providers_dev_only';
export const DEFAULT_WHATSAPP_APP_SECRET = 'fake-providers-whatsapp-app-secret-dev-only';

export function buildServer(
  store: FakeStore = createStore(),
  options: FakeProvidersOptions = {},
): FastifyInstance {
  // Inbound WhatsApp media arrives base64-encoded in test requests.
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  const ids = idGenerator();

  // The fake checkout and selfie pages post plain HTML forms.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  app.get('/health', () => ({ ok: true }));

  registerSms(app, store, ids);
  registerWhatsApp(app, store, ids, {
    appSecret: options.whatsappAppSecret ?? DEFAULT_WHATSAPP_APP_SECRET,
    webhookUrl: options.whatsappWebhookUrl,
  });
  registerPush(app, store, ids);
  registerPayments(app, store, ids, {
    secretKey: options.paymentsSecretKey ?? DEFAULT_PAYMENTS_SECRET_KEY,
    webhookUrl: options.paymentsWebhookUrl,
  });
  registerIdentity(app, store, ids, { webhookUrl: options.identityWebhookUrl });
  registerAddressLookup(app);

  app.get('/messages', async (request, reply) => {
    const query = z
      .object({ channel: z.string().optional(), to: z.string().optional() })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid query' });
    const { channel, to } = query.data;
    return store.messages.filter(
      (m) => (!channel || m.channel === channel) && (!to || m.to === to),
    );
  });

  // Clears the captured messages only: subaccounts, charges and the rest stay, so a test that
  // clears its inbox does not lose the payments the seed set up (M4b links and tenant e2e).
  app.delete('/messages', async (_request, reply) => {
    store.messages.length = 0;
    return reply.code(204).send();
  });

  // Resets every store, payments included: a clean fake.
  app.delete('/_reset', async (_request, reply) => {
    resetStore(store);
    return reply.code(204).send();
  });

  // Dev inbox: where you read sign-in codes locally.
  app.get('/', async (_request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(renderInbox(store)),
  );

  return app;
}
