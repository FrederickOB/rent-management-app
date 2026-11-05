import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFixture, replayFetch } from '../testing/replay';
import { parsePostmarkEvent, parsePostmarkInbound, PostmarkEmail } from './email';

/** CM-10 the Postmark adapter (decision 2), on recorded responses from Postmark's documentation. */
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'postmark');
const make = (file: string, status = 200) => {
  const replay = replayFetch(FIXTURES, { 'POST /email': { file, status } });
  return {
    ...replay,
    port: new PostmarkEmail({
      serverToken: 'fixture-token',
      defaultFrom: 'Osu Ridge <no-reply@rent.test>',
      baseUrl: 'https://api.postmark.test',
      fetch: replay.fetch,
    }),
  };
};

describe('CM-10 Postmark adapter (recorded fixtures)', () => {
  it('sends with the reply address, List-Unsubscribe, attachments and our reference', async () => {
    const { port, calls } = make('send-ok.json');
    const result = await port.send({
      to: 'tenant@example.test',
      subject: 'Receipt',
      text: 'Your receipt',
      replyTo: 'reply+token@inbound.rent.test',
      headers: {
        'List-Unsubscribe': '<https://links.rent.test/u/abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      attachments: [
        { filename: 'r.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') },
      ],
      reference: 'm-1',
    });
    expect(result.providerMessageId).toBe('b7bc2f4a-e38e-4336-af7d-e6c392c2f817');
    expect(calls[0]!.headers.get('x-postmark-server-token')).toBe('fixture-token');
    expect(calls[0]!.body).toMatchObject({
      ReplyTo: 'reply+token@inbound.rent.test',
      Headers: [
        { Name: 'List-Unsubscribe', Value: '<https://links.rent.test/u/abc>' },
        { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
      ],
      Attachments: [
        {
          Name: 'r.pdf',
          ContentType: 'application/pdf',
          Content: Buffer.from('%PDF').toString('base64'),
        },
      ],
      Metadata: { reference: 'm-1' },
    });
  });

  it('treats an inactive recipient as final, and never a header with a line break', async () => {
    const { port } = make('send-inactive.json', 422);
    await expect(
      port.send({ to: 'tenant@example.test', subject: 'x', text: 'y' }),
    ).rejects.toMatchObject({
      retryable: false,
    });
    await expect(
      port.send({
        to: 'tenant@example.test',
        subject: 'x',
        text: 'y',
        headers: { 'X-A': 'a\r\nBcc: z' },
      }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('reads an inbound reply with its stripped text, every recipient and attachments', () => {
    const inbound = parsePostmarkInbound(readFixture(FIXTURES, 'inbound.json'));
    expect(inbound).toMatchObject({
      from: 'ama.tenant@example.test',
      strippedReply: 'Thanks, but the amount looks wrong.',
      subject: 'Re: Receipt RCT-000012',
    });
    expect(inbound!.recipients).toContain(
      'reply+zq3s9x_ab-7cd2ef4gh6ij8kl0mn1op3qr5st7uv9w@inbound.rent.test',
    );
    expect(inbound!.attachments[0]).toMatchObject({
      filename: 'proof.pdf',
      contentType: 'application/pdf',
    });
  });

  it('reads deliveries and bounces as events', () => {
    expect(parsePostmarkEvent(readFixture(FIXTURES, 'delivery.json'))).toMatchObject({
      providerMessageId: 'b7bc2f4a-e38e-4336-af7d-e6c392c2f817',
      status: 'delivered',
      reference: 'm-1',
    });
    expect(parsePostmarkEvent(readFixture(FIXTURES, 'bounce.json'))).toMatchObject({
      status: 'failed',
      reason: 'hardbounce',
    });
  });
});
