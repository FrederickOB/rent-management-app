import { beforeEach, describe, expect, it } from 'vitest';
import type { SmsPort } from '../sms/sms';
import { fakePhone, uniqueReference } from './fixtures';

export interface SmsHarness {
  readonly port: SmsPort;
  /** Messages as the provider recorded them. */
  sent(): Promise<readonly { providerMessageId: string; to: string; body: string }[]>;
}

/** What every SMS adapter must do. */
export function smsContract(
  adapter: string,
  makeHarness: () => SmsHarness | Promise<SmsHarness>,
): void {
  describe(`PLATFORM integration contracts: SMS (${adapter})`, () => {
    let h: SmsHarness;
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('sends a message, which the provider records under the returned id', async () => {
      const to = fakePhone();
      const result = await h.port.send({
        to,
        body: 'Rent reminder: GH₵1,500.00 is due on 1 November.',
        reference: uniqueReference('sms'),
      });
      expect(result.provider).toBe(h.port.provider);
      expect(result.providerMessageId).not.toBe('');
      const recorded = (await h.sent()).find(
        (m) => m.providerMessageId === result.providerMessageId,
      );
      expect(recorded).toMatchObject({
        to,
        body: 'Rent reminder: GH₵1,500.00 is due on 1 November.',
      });
    });

    it('gives every message its own id', async () => {
      const to = fakePhone();
      const one = await h.port.send({ to, body: 'first' });
      const two = await h.port.send({ to, body: 'second' });
      expect(one.providerMessageId).not.toBe(two.providerMessageId);
    });

    it('parses a delivery report and returns null for anything else', () => {
      expect(
        h.port.parseDeliveryReport({
          id: 'abc',
          status: 'delivered',
          at: '2026-10-28T10:00:00.000Z',
        }),
      ).toEqual({
        providerMessageId: 'abc',
        status: 'delivered',
        at: '2026-10-28T10:00:00.000Z',
      });
      for (const body of [
        null,
        'delivered',
        {},
        { id: 'abc', status: 'unknown', at: 'x' },
        { id: 1, status: 'sent', at: 'x' },
      ]) {
        expect(h.port.parseDeliveryReport(body)).toBeNull();
      }
    });
  });
}
