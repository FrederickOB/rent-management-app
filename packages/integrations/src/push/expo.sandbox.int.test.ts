import { describe, expect, it } from 'vitest';
import { ExpoPush } from './push';

/** Decision 5 the Expo smoke test: runs only with EXPO_TEST_PUSH_TOKEN (a device's real token). */
const device = process.env.EXPO_TEST_PUSH_TOKEN ?? '';

describe.runIf(device)('CM-09 the Expo push smoke test', () => {
  it('sends one notification and reads its receipt', async () => {
    const push = new ExpoPush(
      process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : {},
    );
    const [ticket] = await push.send({
      tokens: [device],
      title: 'Rent platform',
      body: 'Smoke test',
    });
    expect(ticket && 'ticketId' in ticket).toBe(true);
  });
});
