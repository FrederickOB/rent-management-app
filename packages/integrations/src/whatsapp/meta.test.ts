import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFixture, replayFetch } from '../testing/replay';
import { MetaError, MetaWhatsApp, verifyMetaChallenge } from './meta';
import {
  parseMetaTemplateStatus,
  parseMetaWebhookDetailed,
  signMetaWebhook,
  verifyMetaSignature,
} from './whatsapp';

/**
 * CM-01 the Meta WhatsApp adapter, on recorded responses in the shapes of Meta's Cloud API
 * documentation (fixtures/meta). No request leaves this machine.
 */
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'meta');
const BASE = 'https://graph.facebook.test';
const port = (routes: Parameters<typeof replayFetch>[1]) => {
  const replay = replayFetch(FIXTURES, routes);
  return {
    ...replay,
    port: new MetaWhatsApp({
      accessToken: 'fixture-token',
      graphVersion: 'v23.0',
      defaultPhoneNumberId: '106540352242922',
      baseUrl: BASE,
      fetch: replay.fetch,
    }),
  };
};

describe('CM-01 Meta WhatsApp adapter (recorded fixtures)', () => {
  it('sends text, templates, documents and reply buttons from the number asked for, with the token', async () => {
    const { port: meta, calls } = port({
      'POST /v23.0/106540352242922/messages': { file: 'send-ok.json' },
      'POST /v23.0/999999999999/messages': { file: 'send-ok.json' },
    });
    const sent = await meta.sendText({ to: '+233200000101', body: 'Hello', reference: 'm-1' });
    expect(sent.providerMessageId).toMatch(/^wamid\./);
    await meta.sendTemplate({
      to: '+233200000101',
      from: '999999999999',
      template: 'receipt_ready_v1',
      language: 'en',
      parameters: ['Osu Ridge', 'Ama'],
    });
    await meta.sendMedia({
      to: '+233200000101',
      mediaUrl: 'https://files.test/r.pdf',
      filename: 'r.pdf',
    });
    await meta.sendInteractive({
      to: '+233200000101',
      body: 'Reply with a number',
      choices: [
        { id: 'balance', title: 'Balance' },
        { id: 'pay', title: 'Pay rent' },
      ],
    });
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/v23.0/106540352242922/messages',
      '/v23.0/999999999999/messages',
      '/v23.0/106540352242922/messages',
      '/v23.0/106540352242922/messages',
    ]);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer fixture-token');
    expect(calls[0]!.body).toMatchObject({
      to: '+233200000101',
      type: 'text',
      biz_opaque_callback_data: 'm-1',
    });
    expect(calls[1]!.body).toMatchObject({
      type: 'template',
      template: { name: 'receipt_ready_v1', components: [{ type: 'body' }] },
    });
    expect(calls[3]!.body).toMatchObject({ type: 'interactive', interactive: { type: 'button' } });
  });

  it('treats "not on WhatsApp" as final and throttling as worth retrying, without quoting Meta’s text', async () => {
    const { port: gone } = port({
      'POST /v23.0/106540352242922/messages': { status: 400, file: 'error-undeliverable.json' },
    });
    const error = await gone.sendText({ to: '+233200000101', body: 'Hi' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaError);
    expect(error).toMatchObject({ retryable: false, metaCode: 131026 });
    expect(String((error as Error).message)).not.toContain('undeliverable');
    const { port: busy } = port({
      'POST /v23.0/106540352242922/messages': { status: 429, file: 'error-throttled.json' },
    });
    await expect(busy.sendText({ to: '+233200000101', body: 'Hi' })).rejects.toMatchObject({
      retryable: true,
      metaCode: 130429,
    });
  });

  it('downloads media in two steps, sending the token only to Meta’s own hosts', async () => {
    const { port: meta, calls } = port({
      'GET /v23.0/1037543291543636': { file: 'media-info.json' },
      'GET https://lookaside.fbsbx.com/whatsapp_business/attachments/': {
        bytes: Buffer.from([0xff, 0xd8, 0xff]),
        contentType: 'image/jpeg',
      },
    });
    const media = await meta.fetchMedia('1037543291543636');
    expect(media.contentType).toBe('image/jpeg');
    expect(media.bytes.length).toBe(3);
    expect(calls[1]!.url.hostname).toBe('lookaside.fbsbx.com');
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer fixture-token');
  });

  it('lists an account’s templates across pages (CM-07)', async () => {
    const { port: meta, calls } = port({
      'GET /v23.0/102290129340398/message_templates?after=b': { file: 'templates-page-2.json' },
      'GET /v23.0/102290129340398/message_templates': { file: 'templates-page-1.json' },
    });
    const templates = await meta.listTemplates('102290129340398');
    expect(calls).toHaveLength(2);
    expect(templates).toEqual([
      {
        metaTemplateId: '1111111111',
        name: 'rent_reminder_v1',
        language: 'en',
        status: 'approved',
        category: 'utility',
      },
      {
        metaTemplateId: '2222222222',
        name: 'receipt_ready_v1',
        language: 'en',
        status: 'pending',
        category: 'utility',
      },
      {
        metaTemplateId: '3333333333',
        name: 'pay_link_v1',
        language: 'en',
        status: 'rejected',
        category: 'utility',
        reason: 'INVALID_FORMAT',
      },
    ]);
  });

  it('never follows a next-page link off Meta’s API', async () => {
    const { port: meta, calls } = port({
      'GET /v23.0/102290129340398/message_templates': { file: 'templates-page-1.json' },
    });
    const elsewhere = new MetaWhatsApp({
      accessToken: 'fixture-token',
      graphVersion: 'v23.0',
      defaultPhoneNumberId: '106540352242922',
      baseUrl: 'https://graph.other.test',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        return (meta as unknown as { options: { fetch: typeof fetch } }).options.fetch(
          `https://graph.facebook.test${url.pathname}`,
          init,
        );
      },
    });
    await elsewhere.listTemplates('102290129340398');
    expect(calls).toHaveLength(1);
  });

  it('reads a webhook batch: each message with its number, choice and media, and a status with its pricing', () => {
    const events = parseMetaWebhookDetailed(readFixture(FIXTURES, 'webhook-batch.json'));
    expect(events.map((e) => e.kind)).toEqual(['message', 'message', 'message', 'status']);
    expect(events[0]).toMatchObject({
      from: '+233200000101',
      text: '1',
      phoneNumberId: '106540352242922',
    });
    expect(events[1]).toMatchObject({
      mediaIds: ['1037543291543636'],
      media: [
        { id: '1037543291543636', kind: 'image', mimeType: 'image/jpeg', caption: 'The leak' },
      ],
    });
    expect(events[2]).toMatchObject({ choiceId: 'receipt', text: 'Receipt' });
    expect(events[3]).toMatchObject({
      status: 'delivered',
      pricing: { category: 'utility', billable: true },
    });
    expect(parseMetaTemplateStatus(readFixture(FIXTURES, 'webhook-template-status.json'))).toEqual([
      {
        kind: 'template_status',
        wabaId: '102290129340398',
        metaTemplateId: '3333333333',
        name: 'pay_link_v1',
        language: 'en',
        status: 'rejected',
        reason: 'INVALID_FORMAT',
      },
    ]);
  });

  it('refuses a changed body, and answers Meta’s verify challenge only with our token', () => {
    const body = JSON.stringify(readFixture(FIXTURES, 'webhook-batch.json'));
    const signature = signMetaWebhook(body, 'app-secret');
    expect(verifyMetaSignature(body, signature, 'app-secret')).toBe(true);
    expect(verifyMetaSignature(body.replace('"1"', '"2"'), signature, 'app-secret')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 'app-secret')).toBe(false);
    const query = {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'ours',
      'hub.challenge': '1158201444',
    };
    expect(verifyMetaChallenge(query, 'ours')).toBe('1158201444');
    expect(verifyMetaChallenge({ ...query, 'hub.verify_token': 'theirs' }, 'ours')).toBeNull();
    expect(verifyMetaChallenge(query, '')).toBeNull();
  });
});
