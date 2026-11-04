import { describe, expect, it } from 'vitest';
import { PostmarkEmail } from './email';

/**
 * CM-10 the Postmark smoke test (M6 decision 14): runs only with POSTMARK_TEST_SERVER_TOKEN. With
 * Postmark's own `POSTMARK_API_TEST` token, Postmark validates the request and sends nothing.
 */
const token = process.env.POSTMARK_TEST_SERVER_TOKEN ?? '';

describe.runIf(token)('CM-10 the Postmark smoke test', () => {
  it('accepts a message with a reply address and List-Unsubscribe', async () => {
    const email = new PostmarkEmail({
      serverToken: token,
      defaultFrom: process.env.POSTMARK_TEST_FROM ?? 'Rent Platform <no-reply@example.com>',
    });
    const result = await email.send({
      to: process.env.POSTMARK_TEST_RECIPIENT ?? 'test@blackhole.postmarkapp.com',
      subject: 'Rent platform smoke test',
      text: 'Please ignore.',
      replyTo: 'reply+smoke@example.com',
      headers: { 'List-Unsubscribe': '<https://example.com/u/smoke>' },
    });
    expect(result.providerMessageId.length).toBeGreaterThan(0);
  });
});
