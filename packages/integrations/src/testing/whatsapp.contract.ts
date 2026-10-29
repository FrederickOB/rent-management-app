import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../http';
import type { SentWhatsApp, WhatsAppPort, WhatsAppTestControls } from '../whatsapp/whatsapp';
import { fakePhone, SAMPLE_PDF, SAMPLE_PNG, uniqueReference } from './fixtures';

export interface WhatsAppHarness {
  readonly port: WhatsAppPort & WhatsAppTestControls;
  /** The secret the provider signs webhooks with. */
  readonly appSecret: string;
  /** Messages as the provider recorded them. */
  sent(): Promise<readonly SentWhatsApp[]>;
}

const refused = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).retryable).toBe(false);
};

/** What every WhatsApp adapter must do. */
export function whatsAppContract(
  adapter: string,
  makeHarness: () => WhatsAppHarness | Promise<WhatsAppHarness>,
): void {
  describe(`PLATFORM integration contracts: WhatsApp (${adapter})`, () => {
    let h: WhatsAppHarness;
    const recorded = async (providerMessageId: string) =>
      (await h.sent()).find((m) => m.providerMessageId === providerMessageId);

    beforeEach(async () => {
      h = await makeHarness();
    });

    it('sends a text, which the provider records under the returned id', async () => {
      const to = fakePhone();
      const reference = uniqueReference('wa');
      const result = await h.port.sendText({ to, body: 'Hello from your landlord', reference });
      expect(result.provider).toBe(h.port.provider);
      expect(result.providerMessageId).not.toBe('');
      expect(await recorded(result.providerMessageId)).toMatchObject({
        to,
        type: 'text',
        body: 'Hello from your landlord',
        reference,
      });
    });

    it('gives every message its own id', async () => {
      const to = fakePhone();
      const one = await h.port.sendText({ to, body: 'one' });
      const two = await h.port.sendText({ to, body: 'two' });
      expect(one.providerMessageId).not.toBe(two.providerMessageId);
    });

    it('sends an approved template with its parameters in order', async () => {
      const to = fakePhone();
      const result = await h.port.sendTemplate({
        to,
        template: 'rent_reminder',
        language: 'en',
        parameters: ['Ama', 'GH₵1,500.00', '1 November 2026'],
      });
      expect(await recorded(result.providerMessageId)).toMatchObject({
        to,
        type: 'template',
        template: 'rent_reminder',
        language: 'en',
        parameters: ['Ama', 'GH₵1,500.00', '1 November 2026'],
      });
    });

    it('sends a document by link, with its file name and caption, and an image', async () => {
      const to = fakePhone();
      const document = await h.port.sendMedia({
        to,
        mediaUrl: 'https://files.example.test/receipt.pdf?signature=abc',
        filename: 'receipt-0001.pdf',
        caption: 'Your receipt',
      });
      expect(await recorded(document.providerMessageId)).toMatchObject({
        to,
        type: 'document',
        mediaUrl: 'https://files.example.test/receipt.pdf?signature=abc',
        filename: 'receipt-0001.pdf',
        caption: 'Your receipt',
      });
      const image = await h.port.sendMedia({
        to,
        kind: 'image',
        mediaUrl: 'https://files.example.test/photo.jpg',
      });
      expect(await recorded(image.providerMessageId)).toMatchObject({ to, type: 'image' });
    });

    it('refuses a recipient that is not an E.164 number, without retrying', async () => {
      await refused(h.port.sendText({ to: '0200000001', body: 'hello' }));
      await refused(
        h.port.sendTemplate({
          to: '233200000001',
          template: 'rent_reminder',
          language: 'en',
          parameters: [],
        }),
      );
    });

    it('refuses template parameters with new lines, tabs or runs of spaces, as Meta does', async () => {
      for (const parameter of ['line\nbreak', 'tab\there', 'five     spaces', '']) {
        await refused(
          h.port.sendTemplate({
            to: fakePhone(),
            template: 'rent_reminder',
            language: 'en',
            parameters: [parameter],
          }),
        );
      }
      await refused(
        h.port.sendTemplate({
          to: fakePhone(),
          template: 'Rent Reminder',
          language: 'en',
          parameters: [],
        }),
      );
    });

    it('delivers an inbound text as a signed webhook that parses back to the sender and text', async () => {
      const from = fakePhone();
      const webhook = await h.port.simulateInbound({ from, text: 'My sink is leaking' });
      expect(h.port.verifySignature(webhook.rawBody, webhook.signature, h.appSecret)).toBe(true);
      expect(
        h.port.verifySignature(Buffer.from(webhook.rawBody), webhook.signature, h.appSecret),
      ).toBe(true);
      const events = h.port.parseInbound(JSON.parse(webhook.rawBody));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'message',
        from,
        type: 'text',
        text: 'My sink is leaking',
        mediaIds: [],
      });
      expect(events[0]?.providerMessageId).not.toBe('');
      expect(Number.isNaN(Date.parse(events[0]?.at ?? ''))).toBe(false);
    });

    it('lets inbound media be fetched by its id, byte for byte', async () => {
      const from = fakePhone();
      const photo = await h.port.simulateInbound({
        from,
        text: 'Photo of the leak',
        media: { contentType: 'image/png', bytes: SAMPLE_PNG },
      });
      const [event] = h.port.parseInbound(JSON.parse(photo.rawBody));
      expect(event).toMatchObject({
        kind: 'message',
        from,
        type: 'image',
        text: 'Photo of the leak',
      });
      const mediaId = event?.kind === 'message' ? event.mediaIds[0] : undefined;
      expect(mediaId).toBeDefined();
      const media = await h.port.fetchMedia(mediaId ?? '');
      expect(media.contentType.startsWith('image/png')).toBe(true);
      expect(media.bytes.equals(SAMPLE_PNG)).toBe(true);

      const pdf = await h.port.simulateInbound({
        from,
        media: { contentType: 'application/pdf', bytes: SAMPLE_PDF, filename: 'lease.pdf' },
      });
      const [document] = h.port.parseInbound(JSON.parse(pdf.rawBody));
      expect(document).toMatchObject({ kind: 'message', type: 'document' });
      const documentId = document?.kind === 'message' ? (document.mediaIds[0] ?? '') : '';
      expect((await h.port.fetchMedia(documentId)).bytes.equals(SAMPLE_PDF)).toBe(true);
    });

    it('reports delivery statuses for a sent message, with its reference', async () => {
      const to = fakePhone();
      const reference = uniqueReference('wa');
      const sent = await h.port.sendText({ to, body: 'Receipt attached', reference });
      const delivered = await h.port.simulateStatus({
        providerMessageId: sent.providerMessageId,
        status: 'delivered',
      });
      expect(h.port.verifySignature(delivered.rawBody, delivered.signature, h.appSecret)).toBe(
        true,
      );
      expect(h.port.parseInbound(JSON.parse(delivered.rawBody))).toEqual([
        expect.objectContaining({
          kind: 'status',
          providerMessageId: sent.providerMessageId,
          recipient: to,
          status: 'delivered',
          reference,
        }),
      ]);
      const failed = await h.port.simulateStatus({
        providerMessageId: sent.providerMessageId,
        status: 'failed',
        errorCode: '131047',
      });
      expect(h.port.parseInbound(JSON.parse(failed.rawBody))).toEqual([
        expect.objectContaining({ kind: 'status', status: 'failed', errorCode: '131047' }),
      ]);
    });

    it('rejects a webhook whose body, signature or secret is wrong', async () => {
      const webhook = await h.port.simulateInbound({ from: fakePhone(), text: 'hello' });
      expect(h.port.verifySignature(`${webhook.rawBody} `, webhook.signature, h.appSecret)).toBe(
        false,
      );
      expect(
        h.port.verifySignature(webhook.rawBody, webhook.signature, `${h.appSecret}-other`),
      ).toBe(false);
      expect(h.port.verifySignature(webhook.rawBody, undefined, h.appSecret)).toBe(false);
      expect(
        h.port.verifySignature(
          webhook.rawBody,
          webhook.signature.replace('sha256=', 'sha1='),
          h.appSecret,
        ),
      ).toBe(false);
      expect(h.port.verifySignature(webhook.rawBody, `${webhook.signature}00`, h.appSecret)).toBe(
        false,
      );
      expect(() => h.port.verifySignature(webhook.rawBody, webhook.signature, '')).toThrow();
    });

    it('treats unknown media as a non-retryable error', async () => {
      await refused(h.port.fetchMedia('no-such-media'));
    });

    it('returns no events for bodies that are not WhatsApp webhooks', () => {
      for (const body of [
        null,
        'text',
        42,
        {},
        { object: 'page', entry: [] },
        { id: 'abc', status: 'delivered', at: 'x' },
      ]) {
        expect(h.port.parseInbound(body)).toEqual([]);
      }
    });
  });
}
