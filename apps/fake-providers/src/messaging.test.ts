import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, createStore, DEFAULT_WHATSAPP_APP_SECRET } from './server';
import { hmac, startReceiver } from './test-support';
import { FAKE_WHATSAPP_PHONE_NUMBER_ID } from './whatsapp';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function receiver() {
  const r = await startReceiver();
  closers.push(r.close);
  return r;
}

describe('CM-01 and CM-03 fake providers: WhatsApp for M6', () => {
  it('accepts reply buttons and lists from a named number, and reports pricing on statuses', async () => {
    const hook = await receiver();
    const store = createStore();
    const app = buildServer(store, { whatsappWebhookUrl: hook.url });
    const sent = await app.inject({
      method: 'POST',
      url: '/whatsapp/messages',
      payload: {
        messaging_product: 'whatsapp',
        to: '+233200000021',
        from_phone_number_id: '100000000000002',
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Reply with a number' },
          action: { buttons: [{ type: 'reply', reply: { id: 'balance', title: 'Balance' } }] },
        },
      },
    });
    expect(sent.statusCode).toBe(200);
    expect(store.messages[0]?.meta).toMatchObject({
      type: 'interactive',
      from: '100000000000002',
      choices: [{ id: 'balance', title: 'Balance' }],
    });
    const id = sent.json<{ messages: { id: string }[] }>().messages[0]!.id;
    await app.inject({
      method: 'POST',
      url: '/whatsapp/_test/status',
      payload: { providerMessageId: id, status: 'read' },
    });
    const body = JSON.parse(hook.received[0]!.body) as {
      entry: {
        changes: {
          value: { metadata: { phone_number_id: string }; statuses: { pricing: unknown }[] };
        }[];
      }[];
    };
    expect(body.entry[0]!.changes[0]!.value.metadata.phone_number_id).toBe('100000000000002');
    expect(body.entry[0]!.changes[0]!.value.statuses[0]!.pricing).toMatchObject({
      category: 'service',
    });
  });

  it('simulates a reply button, on the shared number by default, and records it for the chat page', async () => {
    const hook = await receiver();
    const store = createStore();
    const app = buildServer(store, { whatsappWebhookUrl: hook.url });
    const response = await app.inject({
      method: 'POST',
      url: '/whatsapp/_test/inbound',
      payload: { from: '+233200000021', choiceId: 'balance', text: 'Balance' },
    });
    expect(response.statusCode).toBe(200);
    const raw = hook.received[0]!;
    expect(raw.headers['x-hub-signature-256']).toBe(
      `sha256=${hmac('sha256', DEFAULT_WHATSAPP_APP_SECRET, raw.body)}`,
    );
    expect(raw.body).toContain(FAKE_WHATSAPP_PHONE_NUMBER_ID);
    expect(raw.body).toContain('"button_reply":{"id":"balance"');
    expect(store.inbound[0]).toMatchObject({
      channel: 'whatsapp',
      from: '+233200000021',
      body: 'Balance',
    });
    const page = await app.inject({ method: 'GET', url: '/chat?phone=%2B233200000021' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Balance');
    const posted = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'phone=%2B233200000021&text=hello',
    });
    expect(posted.statusCode).toBe(303);
    expect(store.inbound[0]?.body).toBe('hello');
  });

  it('lists templates and posts Meta’s template review webhook (CM-07)', async () => {
    const hook = await receiver();
    const app = buildServer(createStore(), { whatsappWebhookUrl: hook.url });
    await app.inject({
      method: 'POST',
      url: '/whatsapp/_test/template-status',
      payload: { name: 'receipt_ready_v1', language: 'en', status: 'APPROVED' },
    });
    const list = (await app.inject({ method: 'GET', url: '/whatsapp/templates' })).json<{
      data: { name: string; status: string }[];
    }>();
    expect(list.data).toEqual([
      expect.objectContaining({ name: 'receipt_ready_v1', status: 'APPROVED' }),
    ]);
    expect(hook.received[0]!.body).toContain('message_template_status_update');
  });
});

describe('CM-09 and CM-10 fake providers: SMS and email webhooks', () => {
  it('posts SMS replies and delivery reports in Hubtel’s shapes', async () => {
    const inbound = await receiver();
    const status = await receiver();
    const store = createStore();
    const app = buildServer(store, { smsInboundUrl: inbound.url, smsStatusUrl: status.url });
    await app.inject({
      method: 'POST',
      url: '/sms/_test/inbound',
      payload: { from: '+233200000021', text: 'STOP' },
    });
    expect(JSON.parse(inbound.received[0]!.body)).toMatchObject({
      From: '233200000021',
      Content: 'STOP',
    });
    const sent = await app.inject({
      method: 'POST',
      url: '/sms/messages',
      payload: { to: '+233200000021', body: 'Hi' },
    });
    const { id } = sent.json<{ id: string }>();
    await app.inject({
      method: 'POST',
      url: '/sms/_test/status',
      payload: { messageId: id, status: 'Delivered' },
    });
    expect(JSON.parse(status.received[0]!.body)).toMatchObject({
      messageId: id,
      status: 'Delivered',
    });
  });

  it('posts email replies and delivery events in Postmark’s shapes', async () => {
    const inbound = await receiver();
    const events = await receiver();
    const app = buildServer(createStore(), {
      emailInboundUrl: inbound.url,
      emailEventsUrl: events.url,
    });
    await app.inject({
      method: 'POST',
      url: '/email/_test/inbound',
      payload: {
        from: 'ama@example.test',
        to: 'reply+abc@inbound.rent.local',
        text: 'Thanks',
        quoted: 'Your receipt',
      },
    });
    expect(JSON.parse(inbound.received[0]!.body)).toMatchObject({
      FromFull: { Email: 'ama@example.test' },
      StrippedTextReply: 'Thanks',
    });
    await app.inject({
      method: 'POST',
      url: '/email/_test/event',
      payload: { messageId: 'm-1', recordType: 'Bounce', recipient: 'ama@example.test' },
    });
    expect(JSON.parse(events.received[0]!.body)).toMatchObject({
      RecordType: 'Bounce',
      MessageID: 'm-1',
    });
  });
});
