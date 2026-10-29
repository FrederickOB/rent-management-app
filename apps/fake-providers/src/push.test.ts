import { describe, expect, it } from 'vitest';
import { buildServer, createStore } from './server';

const token = (label: string) => `ExponentPushToken[${label}]`;

describe('PLATFORM fake providers: push', () => {
  it('returns a ticket per notification and receipts like Expo', async () => {
    const store = createStore();
    const app = buildServer(store);
    const response = await app.inject({
      method: 'POST',
      url: '/push/send',
      payload: [
        { to: token('phone'), title: 'Receipt', body: 'Paid', data: { url: '/receipts/1' } },
        { to: 'garbage', title: 'Receipt', body: 'Paid' },
        { to: token('unregistered-tablet'), title: 'Receipt', body: 'Paid' },
      ],
    });
    expect(response.statusCode).toBe(200);
    const tickets = response.json<{
      data: { status: string; id?: string; details?: { error: string } }[];
    }>().data;
    expect(tickets.map((t) => t.status)).toEqual(['ok', 'error', 'ok']);
    expect(tickets[1]?.details?.error).toBe('DeviceNotRegistered');
    expect(store.messages.filter((m) => m.channel === 'push')).toHaveLength(2);

    const ids = [tickets[0]?.id, tickets[2]?.id, 'unknown'];
    const receipts = await app.inject({
      method: 'POST',
      url: '/push/getReceipts',
      payload: { ids },
    });
    expect(receipts.json()).toEqual({
      data: {
        [String(ids[0])]: { status: 'ok' },
        [String(ids[1])]: {
          status: 'error',
          message: expect.any(String),
          details: { error: 'DeviceNotRegistered' },
        },
      },
    });
  });

  it('refuses a notification over 4 KB per ticket, and more than 100 notifications per request', async () => {
    const app = buildServer();
    const big = await app.inject({
      method: 'POST',
      url: '/push/send',
      payload: [{ to: token('a'), title: 't', body: 'x'.repeat(5000) }],
    });
    expect(big.json<{ data: { details?: { error: string } }[] }>().data[0]?.details?.error).toBe(
      'MessageTooBig',
    );
    const many = Array.from({ length: 101 }, (_, i) => ({
      to: token(`d${i}`),
      title: 't',
      body: 'b',
    }));
    expect(
      (await app.inject({ method: 'POST', url: '/push/send', payload: many })).statusCode,
    ).toBe(400);
  });
});
