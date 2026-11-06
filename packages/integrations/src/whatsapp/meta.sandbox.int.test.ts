import { describe, expect, it } from 'vitest';
import { MetaWhatsApp } from './meta';

/**
 * CM-01 the Meta sandbox smoke test (M6 decision 14): runs only when a Meta developer app's test
 * number is configured (META_TEST_ACCESS_TOKEN, META_TEST_PHONE_NUMBER_ID, META_TEST_WABA_ID and
 * META_TEST_RECIPIENT, a number added to the test number's allowed list). It sends Meta's
 * `hello_world` template, which every test number has, and lists the account's templates.
 */
const token = process.env.META_TEST_ACCESS_TOKEN ?? '';
const phoneNumberId = process.env.META_TEST_PHONE_NUMBER_ID ?? '';
const wabaId = process.env.META_TEST_WABA_ID ?? '';
const recipient = process.env.META_TEST_RECIPIENT ?? '';

describe.runIf(token && phoneNumberId && wabaId && recipient)(
  'CM-01 the Meta sandbox smoke test',
  () => {
    it('sends hello_world from the test number and lists its templates', async () => {
      const meta = new MetaWhatsApp({
        accessToken: token,
        graphVersion: process.env.META_GRAPH_VERSION ?? 'v23.0',
        defaultPhoneNumberId: phoneNumberId,
      });
      const sent = await meta.sendTemplate({
        to: recipient,
        template: 'hello_world',
        language: 'en_US',
        parameters: [],
      });
      expect(sent.providerMessageId).toMatch(/^wamid\./);
      const templates = await meta.listTemplates(wabaId);
      expect(templates.some((t) => t.name === 'hello_world')).toBe(true);
    });
  },
);
