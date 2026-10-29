import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FakeStore, WebhookDelivery } from './store';

export const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 number required');

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** 400 with the zod issues, field by field. */
export function invalid(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const issues = error.issues.map((i) =>
    i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
  );
  return reply.code(400).send({ error: issues.join('; ') });
}

export const hmacHex = (algorithm: 'sha256' | 'sha512', key: string, data: string): string =>
  createHmac(algorithm, key).update(data).digest('hex');

/** Ids unique across restarts, so a restarted fake never reuses an id a database still holds. */
export function idGenerator(): { next(prefix: string): string; nextNumber(): number } {
  let counter = 0;
  return {
    next: (prefix) => `${prefix}-${Date.now().toString(36)}-${(++counter).toString(36)}`,
    nextNumber: () => Date.now() * 1000 + (++counter % 1000),
  };
}

/** The absolute URL of a path on this server, as the caller reached it. */
export const selfUrl = (request: FastifyRequest, path: string): string =>
  `${request.protocol}://${request.host}${path}`;

/** POSTs a signed webhook to the configured URL and records the attempt. Never retried. */
export async function deliverWebhook(
  store: FakeStore,
  kind: WebhookDelivery['kind'],
  event: string,
  url: string | undefined,
  rawBody: string,
  headers: Record<string, string>,
): Promise<WebhookDelivery | null> {
  if (!url) return null;
  const at = new Date().toISOString();
  let delivery: WebhookDelivery;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: rawBody,
      signal: AbortSignal.timeout(5_000),
    });
    delivery = { at, kind, event, url, status: response.status };
  } catch (error) {
    delivery = { at, kind, event, url, error: (error as Error).name };
  }
  store.webhooks.unshift(delivery);
  return delivery;
}

/** A small HTML page; forms may only post back to this server. */
export function htmlPage(reply: FastifyReply, title: string, body: string): FastifyReply {
  return reply
    .type('text/html; charset=utf-8')
    .header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    )
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:14px system-ui;margin:24px;max-width:720px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}button{font:inherit;padding:8px 16px;margin-right:8px}.note{color:#555}</style></head>
<body>${body}</body></html>`);
}
