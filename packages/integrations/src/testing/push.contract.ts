import { beforeEach, describe, expect, it } from 'vitest';
import type { PushPort } from '../push/push';
import { fakeExpoToken } from './fixtures';

export interface PushHarness {
  readonly port: PushPort;
  /** Notifications as the provider recorded them, one per accepted token. */
  sent(): Promise<
    readonly { token: string; title: string; body: string; data?: Record<string, string> }[]
  >;
}

/** What every push adapter must do. */
export function pushContract(
  adapter: string,
  makeHarness: () => PushHarness | Promise<PushHarness>,
): void {
  describe(`PLATFORM integration contracts: push (${adapter})`, () => {
    let h: PushHarness;
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('returns one ticket per token, in order, and the provider records each notification', async () => {
      const tokens = [fakeExpoToken('phone'), fakeExpoToken('tablet')];
      const tickets = await h.port.send({
        tokens,
        title: 'Receipt',
        body: 'We received GH₵1,500.00',
        data: { url: '/receipts/1' },
      });
      expect(tickets.map((t) => t.token)).toEqual(tokens);
      const ids = tickets.map((t) => ('ticketId' in t ? t.ticketId : undefined));
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(2);
      const recorded = await h.sent();
      for (const token of tokens) {
        expect(recorded.find((n) => n.token === token)).toMatchObject({
          title: 'Receipt',
          body: 'We received GH₵1,500.00',
          data: { url: '/receipts/1' },
        });
      }
    });

    it('refuses a malformed token with DeviceNotRegistered without failing the others', async () => {
      const good = fakeExpoToken();
      const tickets = await h.port.send({
        tokens: ['not-a-push-token', good],
        title: 'Hi',
        body: 'Hello',
      });
      expect(tickets[0]).toEqual({ token: 'not-a-push-token', error: 'DeviceNotRegistered' });
      expect(tickets[1]).toMatchObject({ token: good, ticketId: expect.any(String) });
    });

    it('reports receipts: ok when handed on, DeviceNotRegistered for an uninstalled app, pending when unknown', async () => {
      const active = fakeExpoToken();
      const uninstalled = fakeExpoToken('unregistered');
      const tickets = await h.port.send({
        tokens: [active, uninstalled],
        title: 'Reminder',
        body: 'Rent is due soon',
      });
      const ids = tickets.map((t) => ('ticketId' in t ? t.ticketId : ''));
      expect(ids.every((id) => id.length > 0)).toBe(true);
      const receipts = await h.port.getReceipts([...ids, 'unknown-ticket']);
      expect(receipts).toEqual([
        { ticketId: ids[0], status: 'ok' },
        { ticketId: ids[1], status: 'error', error: 'DeviceNotRegistered' },
        { ticketId: 'unknown-ticket', status: 'pending' },
      ]);
    });

    it('sends to more tokens than one provider request takes', async () => {
      const tokens = Array.from({ length: 150 }, (_, i) => fakeExpoToken(`bulk${i}`));
      const tickets = await h.port.send({
        tokens,
        title: 'Notice',
        body: 'Water will be off on Saturday',
      });
      expect(tickets.map((t) => t.token)).toEqual(tokens);
      expect(tickets.every((t) => 'ticketId' in t)).toBe(true);
    });

    it('refuses a notification over 4 KB with MessageTooBig', async () => {
      const token = fakeExpoToken();
      const tickets = await h.port.send({ tokens: [token], title: 'Long', body: 'x'.repeat(4100) });
      expect(tickets).toEqual([{ token, error: 'MessageTooBig' }]);
    });

    it('sends nothing when there are no tokens', async () => {
      expect(await h.port.send({ tokens: [], title: 'Nobody', body: 'Nothing' })).toEqual([]);
      expect(await h.port.getReceipts([])).toEqual([]);
    });
  });
}
