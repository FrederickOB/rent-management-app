import type { AddressInfo } from 'node:net';
import { buildServer } from './server';

if (process.env.NODE_ENV === 'production') {
  console.error('fake-providers must never run in production.');
  process.exit(1);
}

// An empty variable counts as unset.
const env = (name: string) => process.env[name] || undefined;

const port = Number(process.env.PORT ?? 4010);
const host = env('HOST') ?? '0.0.0.0';
const app = buildServer(undefined, {
  paymentsSecretKey: env('FAKE_PAYMENTS_SECRET_KEY'),
  paymentsWebhookUrl: env('FAKE_PAYMENTS_WEBHOOK_URL'),
  whatsappAppSecret: env('FAKE_WHATSAPP_APP_SECRET'),
  whatsappWebhookUrl: env('FAKE_WHATSAPP_WEBHOOK_URL'),
  identityWebhookUrl: env('FAKE_IDENTITY_WEBHOOK_URL'),
});
await app.listen({ port, host });
// PORT=0 picks a free port; print the one actually bound.
const bound = (app.server.address() as AddressInfo).port;
console.log(
  `fake-providers listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${bound}`,
);
