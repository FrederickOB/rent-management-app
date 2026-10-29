import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, createStore, DEFAULT_WHATSAPP_APP_SECRET } from './server';
import { hmac, startReceiver } from './test-support';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const send = (app: ReturnType<typeof buildServer>, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/whatsapp/messages',
    payload: { messaging_product: 'whatsapp', to: '+233200000001', ...payload },
  });

describe('PLATFORM fake providers: WhatsApp', () => {
  it('accepts text, template and document messages in the Cloud API shape', async () => {
    const store = createStore();
    const app = buildServer(store);
    const text = await send(app, {
      type: 'text',
      text: { body: 'Hello' },
      biz_opaque_callback_data: 'msg:1',
    });
    expect(text.statusCode).toBe(200);
    const body = text.json<{ contacts: { wa_id: string }[]; messages: { id: string }[] }>();
    expect(body.contacts[0]?.wa_id).toBe('233200000001');
    expect(body.messages[0]?.id).toMatch(/^wamid\./);

    const template = await send(app, {
      type: 'template',
      template: {
        name: 'rent_reminder',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ama' }] }],
      },
    });
    expect(template.statusCode).toBe(200);
    const document = await send(app, {
      type: 'document',
      document: { link: 'https://files.example.test/r.pdf', filename: 'r.pdf' },
    });
    expect(document.statusCode).toBe(200);

    expect(store.messages.map((m) => m.meta?.type)).toEqual(['document', 'template', 'text']);
    expect(store.messages[1]?.meta).toMatchObject({
      template: 'rent_reminder',
      language: 'en',
      parameters: ['Ama'],
    });
    expect(store.messages[2]?.meta).toMatchObject({ reference: 'msg:1' });
  });

  it('refuses what Meta refuses: local numbers, bad template names and parameters with new lines', async () => {
    const app = buildServer();
    expect(
      (await send(app, { to: '0200000001', type: 'text', text: { body: 'x' } })).statusCode,
    ).toBe(400);
    expect(
      (
        await send(app, {
          type: 'template',
          template: { name: 'Rent Reminder', language: { code: 'en' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await send(app, {
          type: 'template',
          template: {
            name: 'rent_reminder',
            language: { code: 'en' },
            components: [{ type: 'body', parameters: [{ type: 'text', text: 'a\nb' }] }],
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await send(app, { type: 'image', image: { link: 'ftp://files.example.test/x.png' } }))
        .statusCode,
    ).toBe(400);
  });

  it('simulates an inbound message with media, signed with the app secret and delivered to the webhook URL', async () => {
    const receiver = await startReceiver();
    closers.push(receiver.close);
    const app = buildServer(createStore(), {
      whatsappAppSecret: 'test-secret',
      whatsappWebhookUrl: receiver.url,
    });
    const bytes = Buffer.from('fake image bytes');
    const response = await app.inject({
      method: 'POST',
      url: '/whatsapp/_test/inbound',
      payload: {
        from: '+233200000002',
        text: 'Photo',
        media: { contentType: 'image/jpeg', base64: bytes.toString('base64') },
      },
    });
    expect(response.statusCode).toBe(200);
    const { rawBody, signature, mediaId, delivery } = response.json<{
      rawBody: string;
      signature: string;
      mediaId: string;
      delivery: { status: number };
    }>();
    expect(signature).toBe(`sha256=${hmac('sha256', 'test-secret', rawBody)}`);
    expect(delivery.status).toBe(200);
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]?.body).toBe(rawBody);
    expect(receiver.received[0]?.headers['x-hub-signature-256']).toBe(signature);

    const message = JSON.parse(rawBody).entry[0].changes[0].value.messages[0];
    expect(message).toMatchObject({
      from: '233200000002',
      type: 'image',
      image: { id: mediaId, mime_type: 'image/jpeg', caption: 'Photo' },
    });

    const info = await app.inject({ method: 'GET', url: `/whatsapp/media/${mediaId}` });
    expect(info.json()).toMatchObject({
      id: mediaId,
      mime_type: 'image/jpeg',
      file_size: bytes.length,
    });
    const download = await app.inject({
      method: 'GET',
      url: new URL(info.json<{ url: string }>().url).pathname,
    });
    expect(download.headers['content-type']).toBe('image/jpeg');
    expect(download.rawPayload.equals(bytes)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/whatsapp/media/unknown' })).statusCode).toBe(
      404,
    );
  });

  it('simulates a status update that echoes the reference and the error code', async () => {
    const app = buildServer();
    const sent = await send(app, {
      type: 'text',
      text: { body: 'Receipt' },
      biz_opaque_callback_data: 'receipt:7',
    });
    const id = sent.json<{ messages: { id: string }[] }>().messages[0]?.id;
    const response = await app.inject({
      method: 'POST',
      url: '/whatsapp/_test/status',
      payload: { providerMessageId: id, status: 'failed', errorCode: '131047' },
    });
    const { rawBody, signature } = response.json<{ rawBody: string; signature: string }>();
    expect(signature).toBe(`sha256=${hmac('sha256', DEFAULT_WHATSAPP_APP_SECRET, rawBody)}`);
    expect(JSON.parse(rawBody).entry[0].changes[0].value.statuses[0]).toMatchObject({
      id,
      status: 'failed',
      recipient_id: '233200000001',
      biz_opaque_callback_data: 'receipt:7',
      errors: [{ code: 131047 }],
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/whatsapp/_test/status',
          payload: { providerMessageId: 'wamid.none', status: 'read' },
        })
      ).statusCode,
    ).toBe(404);
  });
});
