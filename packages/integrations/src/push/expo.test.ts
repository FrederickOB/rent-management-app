import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayFetch } from '../testing/replay';
import { ExpoPush } from './push';

/** Decision 5 the Expo push adapter, on recorded responses from Expo's documentation. */
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'expo');

describe('CM-09 Expo push adapter (recorded fixtures)', () => {
  it('sends to each token, with the access token, and reads tickets and receipts in order', async () => {
    const { fetch, calls } = replayFetch(FIXTURES, {
      'POST /--/api/v2/push/send': { file: 'send.json' },
      'POST /--/api/v2/push/getReceipts': { file: 'receipts.json' },
    });
    const push = new ExpoPush({
      accessToken: 'expo-token',
      baseUrl: 'https://exp.host.test/--/api/v2/push',
      fetch,
    });
    const tickets = await push.send({
      tokens: ['ExponentPushToken[ok]', 'ExponentPushToken[gone]'],
      title: 'Osu Ridge',
      body: 'Your receipt is ready',
      data: { screen: 'receipts' },
    });
    expect(tickets).toEqual([
      { token: 'ExponentPushToken[ok]', ticketId: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX' },
      { token: 'ExponentPushToken[gone]', error: 'DeviceNotRegistered' },
    ]);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer expo-token');
    const receipts = await push.getReceipts([
      'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
      'YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY',
      'ZZZZ',
    ]);
    expect(receipts.map((r) => r.status)).toEqual(['ok', 'error', 'pending']);
  });
});
