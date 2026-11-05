import { describe, expect, it } from 'vitest';
import { HubtelSms } from './sms';

/**
 * CM-09 the Hubtel smoke test (M6 decision 14): runs only with Hubtel test keys and a recipient
 * (HUBTEL_TEST_CLIENT_ID, HUBTEL_TEST_CLIENT_SECRET, HUBTEL_TEST_RECIPIENT). Hubtel's test mode
 * accepts any sender ID.
 */
const id = process.env.HUBTEL_TEST_CLIENT_ID ?? '';
const secret = process.env.HUBTEL_TEST_CLIENT_SECRET ?? '';
const to = process.env.HUBTEL_TEST_RECIPIENT ?? '';

describe.runIf(id && secret && to)('CM-09 the Hubtel smoke test', () => {
  it('sends one SMS and gets a message id', async () => {
    const sms = new HubtelSms({
      clientId: id,
      clientSecret: secret,
      senderId: process.env.HUBTEL_SENDER_ID ?? 'RentTest',
      ...(process.env.HUBTEL_TEST_BASE_URL ? { baseUrl: process.env.HUBTEL_TEST_BASE_URL } : {}),
    });
    const result = await sms.send({ to, body: 'Rent platform smoke test. Please ignore.' });
    expect(result.providerMessageId.length).toBeGreaterThan(0);
  });
});
