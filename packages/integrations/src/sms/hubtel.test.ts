import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFixture, replayFetch } from '../testing/replay';
import {
  HubtelSms,
  parseHubtelDeliveryReport,
  parseHubtelInbound,
  webhookSecretMatches,
} from './sms';

/** CM-09 the Hubtel SMS adapter (decision 1), on recorded responses from Hubtel's documentation. */
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'hubtel');
const make = (file: string, status = 200) => {
  const replay = replayFetch(FIXTURES, { 'POST /v1/messages/send': { file, status } });
  return {
    ...replay,
    port: new HubtelSms({
      clientId: 'id',
      clientSecret: 'secret',
      senderId: 'OsuRidge',
      baseUrl: 'https://sms.hubtel.test',
      fetch: replay.fetch,
    }),
  };
};

describe('CM-09 Hubtel SMS adapter (recorded fixtures)', () => {
  it('sends from the sender ID with Basic auth and keeps the charge as Hubtel gives it', async () => {
    const { port, calls } = make('send-ok.json');
    const result = await port.send({ to: '+233200000101', body: 'Hello', reference: 'm-1' });
    expect(result).toEqual({
      provider: 'hubtel',
      providerMessageId: 'fab43849-6c5b-4334-a88b-d06520b1ace8',
      cost: { decimal: '0.0246', currency: 'GHS' },
    });
    expect(calls[0]!.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('id:secret').toString('base64')}`,
    );
    expect(calls[0]!.body).toEqual({
      From: 'OsuRidge',
      To: '233200000101',
      Content: 'Hello',
      RegisteredDelivery: true,
      ClientReference: 'm-1',
    });
  });

  it('reads a refusal hidden in a 2xx, and treats an invalid number as final', async () => {
    const { port } = make('send-invalid-destination.json', 201);
    await expect(port.send({ to: '+233200000101', body: 'Hello' })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('reads delivery reports and inbound replies in either key case', () => {
    expect(parseHubtelDeliveryReport(readFixture(FIXTURES, 'delivery.json'))).toMatchObject({
      providerMessageId: 'eadbfcd0-94d1-438f-ad32-0013f34042c2',
      status: 'delivered',
      cost: { decimal: '0.0309', currency: 'GHS' },
    });
    expect(parseHubtelDeliveryReport(readFixture(FIXTURES, 'undelivered.json'))).toMatchObject({
      status: 'failed',
      reason: 'undelivered',
    });
    expect(parseHubtelInbound(readFixture(FIXTURES, 'inbound.json'))).toMatchObject({
      providerMessageId: 'in-7f1c2b',
      from: '+233200000101',
      text: 'STOP',
    });
    expect(parseHubtelInbound({ From: 'not a number', Content: 'x', MessageId: '1' })).toBeNull();
  });

  it('accepts a webhook only with our secret', () => {
    expect(webhookSecretMatches('s3cret-value', 's3cret-value')).toBe(true);
    expect(webhookSecretMatches('s3cret-valuf', 's3cret-value')).toBe(false);
    expect(webhookSecretMatches(undefined, 's3cret-value')).toBe(false);
    expect(webhookSecretMatches('x', undefined)).toBe(false);
  });
});
