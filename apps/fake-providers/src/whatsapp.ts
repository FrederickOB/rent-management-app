import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deliverWebhook, e164, hmacHex, invalid, selfUrl, type idGenerator } from './shared';
import type { Captured, FakeStore } from './store';

export interface WhatsAppOptions {
  /** Signs webhooks, as Meta signs them with the app secret. */
  readonly appSecret: string;
  readonly webhookUrl?: string;
}

const link = z.url({ protocol: /^https?$/ });
const reference = z.string().min(1).max(512).optional();
// Meta refuses template parameters with new lines, tabs or more than four spaces in a row (132018).
const parameterText = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (text) => !/[\n\t]| {5,}/.test(text),
    'no new lines, tabs or more than four spaces in a row',
  );

const base = {
  messaging_product: z.literal('whatsapp'),
  recipient_type: z.literal('individual').optional(),
  to: e164,
  biz_opaque_callback_data: reference,
};

/** Meta Cloud API `POST /{phone-number-id}/messages`, for the types we send. */
const sendSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('text'),
    text: z.object({ body: z.string().min(1).max(4096), preview_url: z.boolean().optional() }),
  }),
  z.object({
    ...base,
    type: z.literal('template'),
    template: z.object({
      name: z
        .string()
        .regex(/^[a-z0-9_]{1,512}$/, 'template names are lower case, digits and underscores'),
      language: z.object({ code: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/) }),
      components: z
        .array(
          z.object({
            type: z.literal('body'),
            parameters: z.array(z.object({ type: z.literal('text'), text: parameterText })),
          }),
        )
        .max(1)
        .optional(),
    }),
  }),
  z.object({
    ...base,
    type: z.literal('image'),
    image: z.object({ link, caption: z.string().max(1024).optional() }),
  }),
  z.object({
    ...base,
    type: z.literal('document'),
    document: z.object({
      link,
      caption: z.string().max(1024).optional(),
      filename: z.string().max(240).optional(),
    }),
  }),
]);

const inboundSchema = z
  .object({
    from: e164,
    text: z.string().min(1).max(4096).optional(),
    media: z
      .object({
        contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
        base64: z.base64().min(1),
        filename: z.string().max(240).optional(),
      })
      .optional(),
  })
  .refine((v) => v.text !== undefined || v.media !== undefined, 'text or media required');

const statusSchema = z.object({
  providerMessageId: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  errorCode: z
    .string()
    .regex(/^\d{1,10}$/)
    .optional(),
});

type SendRequest = z.infer<typeof sendSchema>;

function summarise(message: SendRequest): { body: string; meta: Record<string, unknown> } {
  const common = { type: message.type, reference: message.biz_opaque_callback_data };
  switch (message.type) {
    case 'text':
      return { body: message.text.body, meta: common };
    case 'template': {
      const parameters = message.template.components?.[0]?.parameters.map((p) => p.text) ?? [];
      return {
        body: `[template ${message.template.name}, ${message.template.language.code}] ${parameters.join(' | ')}`,
        meta: {
          ...common,
          template: message.template.name,
          language: message.template.language.code,
          parameters,
        },
      };
    }
    case 'image':
      return {
        body: `[image] ${message.image.caption ?? message.image.link}`,
        meta: { ...common, mediaUrl: message.image.link, caption: message.image.caption },
      };
    case 'document':
      return {
        body: `[document] ${message.document.caption ?? message.document.filename ?? message.document.link}`,
        meta: {
          ...common,
          mediaUrl: message.document.link,
          caption: message.document.caption,
          filename: message.document.filename,
        },
      };
  }
}

function mediaType(contentType: string): 'image' | 'audio' | 'video' | 'document' {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  return 'document';
}

const webhookBody = (value: Record<string, unknown>) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'fake-waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '000000000', phone_number_id: 'fake-phone-number' },
              ...value,
            },
          },
        ],
      },
    ],
  });

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

/** WhatsApp, shaped like Meta's Cloud API: send, media, and simulated inbound messages and statuses. */
export function registerWhatsApp(
  app: FastifyInstance,
  store: FakeStore,
  ids: ReturnType<typeof idGenerator>,
  options: WhatsAppOptions,
): void {
  const signAndDeliver = async (event: string, rawBody: string) => {
    const signature = `sha256=${hmacHex('sha256', options.appSecret, rawBody)}`;
    const delivery = await deliverWebhook(store, 'whatsapp', event, options.webhookUrl, rawBody, {
      'x-hub-signature-256': signature,
    });
    return { rawBody, signature, delivery };
  };

  app.post('/whatsapp/messages', async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { body, meta } = summarise(parsed.data);
    const message: Captured = {
      id: `wamid.${ids.next('fake')}`,
      channel: 'whatsapp',
      to: parsed.data.to,
      body,
      at: new Date().toISOString(),
      meta,
    };
    store.messages.unshift(message);
    return reply.send({
      messaging_product: 'whatsapp',
      contacts: [{ input: parsed.data.to, wa_id: parsed.data.to.slice(1) }],
      messages: [{ id: message.id }],
    });
  });

  app.get<{ Params: { mediaId: string } }>('/whatsapp/media/:mediaId', async (request, reply) => {
    const media = store.media.get(request.params.mediaId);
    if (!media) return reply.code(404).send({ error: 'media not found' });
    return reply.send({
      messaging_product: 'whatsapp',
      id: media.id,
      url: selfUrl(request, `/whatsapp/media/${encodeURIComponent(media.id)}/download`),
      mime_type: media.contentType,
      sha256: media.sha256,
      file_size: media.bytes.length,
    });
  });

  app.get<{ Params: { mediaId: string } }>(
    '/whatsapp/media/:mediaId/download',
    async (request, reply) => {
      const media = store.media.get(request.params.mediaId);
      if (!media) return reply.code(404).send({ error: 'media not found' });
      return reply.type(media.contentType).send(media.bytes);
    },
  );

  // Test controls: a person writes to us, or Meta reports a status. Not part of Meta's API.
  app.post('/whatsapp/_test/inbound', async (request, reply) => {
    const parsed = inboundSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { from, text, media } = parsed.data;
    const waId = from.slice(1);
    const messageId = `wamid.${ids.next('in')}`;
    let content: Record<string, unknown> = { type: 'text', text: { body: text } };
    let mediaId: string | undefined;
    if (media) {
      const bytes = Buffer.from(media.base64, 'base64');
      mediaId = ids.next('media');
      store.media.set(mediaId, {
        id: mediaId,
        contentType: media.contentType,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      const type = mediaType(media.contentType);
      content = {
        type,
        [type]: {
          id: mediaId,
          mime_type: media.contentType,
          ...(text === undefined ? {} : { caption: text }),
          ...(media.filename === undefined ? {} : { filename: media.filename }),
        },
      };
    }
    const rawBody = webhookBody({
      contacts: [{ profile: { name: 'Test contact' }, wa_id: waId }],
      messages: [{ from: waId, id: messageId, timestamp: nowSeconds(), ...content }],
    });
    return reply.send({
      messageId,
      mediaId: mediaId ?? null,
      ...(await signAndDeliver('messages', rawBody)),
    });
  });

  app.post('/whatsapp/_test/status', async (request, reply) => {
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const message = store.messages.find(
      (m) => m.channel === 'whatsapp' && m.id === parsed.data.providerMessageId,
    );
    if (!message) return reply.code(404).send({ error: 'message not found' });
    const messageReference = message.meta?.reference;
    const rawBody = webhookBody({
      statuses: [
        {
          id: message.id,
          status: parsed.data.status,
          timestamp: nowSeconds(),
          recipient_id: message.to.slice(1),
          ...(typeof messageReference === 'string'
            ? { biz_opaque_callback_data: messageReference }
            : {}),
          ...(parsed.data.errorCode === undefined
            ? {}
            : { errors: [{ code: Number(parsed.data.errorCode), title: 'Fake failure' }] }),
        },
      ],
    });
    return reply.send(await signAndDeliver('statuses', rawBody));
  });
}
