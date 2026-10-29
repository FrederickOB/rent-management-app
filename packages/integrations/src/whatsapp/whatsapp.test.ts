import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { whatsAppContract } from '../testing';
import { InMemoryWhatsApp, parseMetaWebhook, verifyMetaSignature } from './whatsapp';

whatsAppContract('in-memory', () => {
  const port = new InMemoryWhatsApp('unit-test-app-secret');
  return { port, appSecret: 'unit-test-app-secret', sent: async () => port.sent };
});

/** A Meta Cloud API webhook in the documented shape, with every kind of event we read. */
const metaWebhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
            contacts: [{ profile: { name: 'Test Tenant' }, wa_id: '233200000101' }],
            messages: [
              {
                from: '233200000101',
                id: 'wamid.text',
                timestamp: '1798448400',
                type: 'text',
                text: { body: 'Hello' },
              },
              {
                from: '233200000101',
                id: 'wamid.image',
                timestamp: '1798448401',
                type: 'image',
                image: {
                  id: 'media-1',
                  mime_type: 'image/jpeg',
                  sha256: 'abc',
                  caption: 'The leak',
                },
              },
              {
                from: '233200000101',
                id: 'wamid.document',
                timestamp: '1798448402',
                type: 'document',
                document: { id: 'media-2', mime_type: 'application/pdf', filename: 'proof.pdf' },
              },
              {
                from: '233200000101',
                id: 'wamid.button',
                timestamp: '1798448403',
                type: 'button',
                button: { text: 'Pay now', payload: 'pay' },
              },
              {
                from: '233200000101',
                id: 'wamid.reply',
                timestamp: '1798448404',
                type: 'interactive',
                interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Yes' } },
              },
              {
                from: '233200000101',
                id: 'wamid.location',
                timestamp: '1798448405',
                type: 'location',
                location: { latitude: 5.6, longitude: -0.2 },
              },
              {
                from: 'not-a-number',
                id: 'wamid.bad',
                timestamp: '1798448406',
                type: 'text',
                text: { body: 'skipped' },
              },
            ],
          },
        },
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            statuses: [
              {
                id: 'wamid.out',
                status: 'read',
                timestamp: '1798448410',
                recipient_id: '233200000102',
                biz_opaque_callback_data: 'receipt:1',
              },
              {
                id: 'wamid.out2',
                status: 'failed',
                timestamp: '1798448411',
                recipient_id: '233200000102',
                errors: [{ code: 131047, title: 'Re-engagement message' }],
              },
              {
                id: 'wamid.out3',
                status: 'deleted',
                timestamp: '1798448412',
                recipient_id: '233200000102',
              },
            ],
          },
        },
        {
          field: 'account_update',
          value: {
            messages: [
              { from: '233200000101', id: 'x', timestamp: '1', type: 'text', text: { body: 'no' } },
            ],
          },
        },
      ],
    },
  ],
};

describe('PLATFORM WhatsApp webhook parsing', () => {
  it('reads messages and statuses in the Meta Cloud API shape, as E.164 numbers and UTC times', () => {
    expect(parseMetaWebhook(metaWebhook)).toEqual([
      {
        kind: 'message',
        providerMessageId: 'wamid.text',
        from: '+233200000101',
        type: 'text',
        text: 'Hello',
        mediaIds: [],
        at: '2026-12-28T09:00:00.000Z',
      },
      {
        kind: 'message',
        providerMessageId: 'wamid.image',
        from: '+233200000101',
        type: 'image',
        text: 'The leak',
        mediaIds: ['media-1'],
        at: '2026-12-28T09:00:01.000Z',
      },
      {
        kind: 'message',
        providerMessageId: 'wamid.document',
        from: '+233200000101',
        type: 'document',
        mediaIds: ['media-2'],
        at: '2026-12-28T09:00:02.000Z',
      },
      {
        kind: 'message',
        providerMessageId: 'wamid.button',
        from: '+233200000101',
        type: 'button',
        text: 'Pay now',
        mediaIds: [],
        at: '2026-12-28T09:00:03.000Z',
      },
      {
        kind: 'message',
        providerMessageId: 'wamid.reply',
        from: '+233200000101',
        type: 'interactive',
        text: 'Yes',
        mediaIds: [],
        at: '2026-12-28T09:00:04.000Z',
      },
      {
        kind: 'message',
        providerMessageId: 'wamid.location',
        from: '+233200000101',
        type: 'location',
        mediaIds: [],
        at: '2026-12-28T09:00:05.000Z',
      },
      {
        kind: 'status',
        providerMessageId: 'wamid.out',
        recipient: '+233200000102',
        status: 'read',
        at: '2026-12-28T09:00:10.000Z',
        reference: 'receipt:1',
      },
      {
        kind: 'status',
        providerMessageId: 'wamid.out2',
        recipient: '+233200000102',
        status: 'failed',
        at: '2026-12-28T09:00:11.000Z',
        errorCode: '131047',
      },
    ]);
  });
});

describe('PLATFORM WhatsApp signature (X-Hub-Signature-256)', () => {
  const body = JSON.stringify(metaWebhook);
  const expected = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;

  it('accepts the HMAC-SHA256 of the raw body under the app secret, in either hex case', () => {
    expect(verifyMetaSignature(body, expected, 'app-secret')).toBe(true);
    expect(
      verifyMetaSignature(
        Buffer.from(body),
        expected.toUpperCase().replace('SHA256=', 'sha256='),
        'app-secret',
      ),
    ).toBe(true);
  });

  it('refuses a changed body, another secret, a truncated or padded signature and other schemes', () => {
    expect(verifyMetaSignature(`${body}\n`, expected, 'app-secret')).toBe(false);
    expect(verifyMetaSignature(body, expected, 'other-secret')).toBe(false);
    expect(verifyMetaSignature(body, expected.slice(0, -1), 'app-secret')).toBe(false);
    expect(verifyMetaSignature(body, `${expected}zz`, 'app-secret')).toBe(false);
    expect(verifyMetaSignature(body, expected.replace('sha256=', ''), 'app-secret')).toBe(false);
    expect(verifyMetaSignature(body, '', 'app-secret')).toBe(false);
  });

  it('refuses to verify without an app secret, rather than accept anything', () => {
    expect(() => verifyMetaSignature(body, expected, '')).toThrow(/not configured/);
  });
});
