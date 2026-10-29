import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emailAddressOf, type EmailPort } from '../email/email';
import { ProviderError } from '../http';
import { fakeEmail, SAMPLE_PDF, uniqueReference } from './fixtures';

/** An email as the receiving side saw it. Addresses are bare; line endings are `\n`. */
export interface ReceivedEmail {
  readonly from: string;
  readonly to: readonly string[];
  readonly replyTo?: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly attachments: readonly { filename: string; contentType: string; size: number }[];
}

export interface EmailHarness {
  readonly port: EmailPort;
  /** The From used when a message names none. */
  readonly defaultFrom: string;
  /** The message as received, found by the id `send` returned. */
  received(providerMessageId: string): Promise<ReceivedEmail | undefined>;
  /** Removes what the test sent, where the receiver keeps it. */
  cleanup?(): Promise<void>;
}

const refused = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).retryable).toBe(false);
};

/** What every email adapter must do. */
export function emailContract(
  adapter: string,
  makeHarness: () => EmailHarness | Promise<EmailHarness>,
): void {
  describe(`PLATFORM integration contracts: email (${adapter})`, () => {
    let h: EmailHarness;
    beforeEach(async () => {
      h = await makeHarness();
    });
    afterEach(async () => {
      await h.cleanup?.();
    });

    it('sends a plain-text email from the default sender', async () => {
      const to = fakeEmail();
      const subject = `Your receipt ${uniqueReference('r')}`;
      const result = await h.port.send({
        to,
        subject,
        text: 'We received GH₵1,500.00.\nThank you.',
      });
      expect(result.provider).toBe(h.port.provider);
      expect(result.providerMessageId).not.toBe('');
      expect(await h.received(result.providerMessageId)).toMatchObject({
        from: emailAddressOf(h.defaultFrom),
        to: [to],
        subject,
        text: 'We received GH₵1,500.00.\nThank you.',
      });
    });

    it('sends HTML with attachments intact', async () => {
      const to = fakeEmail();
      const result = await h.port.send({
        to,
        subject: 'Statement for October',
        text: 'Your statement is attached.',
        html: '<p>Your statement is <strong>attached</strong>.</p>',
        attachments: [
          {
            filename: 'statement-2026-10.pdf',
            contentType: 'application/pdf',
            content: SAMPLE_PDF,
          },
        ],
      });
      const received = await h.received(result.providerMessageId);
      expect(received?.html).toContain('<strong>attached</strong>');
      expect(received?.attachments).toEqual([
        {
          filename: 'statement-2026-10.pdf',
          contentType: 'application/pdf',
          size: SAMPLE_PDF.length,
        },
      ]);
    });

    it('uses an explicit From and Reply-To', async () => {
      const to = fakeEmail();
      const result = await h.port.send({
        to,
        subject: 'From the agency',
        text: 'Hello',
        from: 'Test Agency <agency@example.test>',
        replyTo: 'manager@example.test',
      });
      expect(await h.received(result.providerMessageId)).toMatchObject({
        from: 'agency@example.test',
        replyTo: 'manager@example.test',
      });
    });

    it('gives every message its own id', async () => {
      const to = fakeEmail();
      const one = await h.port.send({ to, subject: 'One', text: 'one' });
      const two = await h.port.send({ to, subject: 'Two', text: 'two' });
      expect(one.providerMessageId).not.toBe(two.providerMessageId);
    });

    it('refuses an invalid recipient or sender, without retrying', async () => {
      await refused(h.port.send({ to: 'not-an-address', subject: 'x', text: 'x' }));
      await refused(
        h.port.send({ to: `${fakeEmail()}, other@example.test`, subject: 'x', text: 'x' }),
      );
      await refused(h.port.send({ to: fakeEmail(), subject: 'x', text: 'x', from: 'nobody' }));
    });

    it('refuses a header with a line break, so nothing can be injected', async () => {
      await refused(
        h.port.send({ to: fakeEmail(), subject: 'Hello\r\nBcc: victim@example.test', text: 'x' }),
      );
      await refused(
        h.port.send({
          to: fakeEmail(),
          subject: 'x',
          text: 'x',
          replyTo: 'a@example.test\nBcc: b@example.test',
        }),
      );
    });

    it('parses an inbound email and returns null for anything else', () => {
      const parsed = h.port.parseInbound({
        messageId: '<inbound-1@example.test>',
        from: 'tenant@example.test',
        to: 'inbox@rent.local',
        subject: 'Leaking roof',
        text: 'Please send someone.',
        attachments: [
          {
            filename: 'roof.pdf',
            contentType: 'application/pdf',
            contentBase64: SAMPLE_PDF.toString('base64'),
          },
        ],
      });
      expect(parsed).toMatchObject({
        providerMessageId: '<inbound-1@example.test>',
        from: 'tenant@example.test',
        subject: 'Leaking roof',
        text: 'Please send someone.',
      });
      expect(parsed?.attachments[0]?.content.equals(SAMPLE_PDF)).toBe(true);
      for (const body of [null, 'mail', {}, { from: 'a@b.c' }]) {
        expect(h.port.parseInbound(body)).toBeNull();
      }
    });
  });
}
