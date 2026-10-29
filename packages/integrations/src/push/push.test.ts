import { describe, expect, it } from 'vitest';
import { pushContract } from '../testing';
import { InMemoryPush, isExpoPushToken, pushPayloadBytes } from './push';

pushContract('in-memory', () => {
  const port = new InMemoryPush();
  return { port, sent: async () => port.sent };
});

describe('PLATFORM push tokens', () => {
  it('recognises Expo push tokens in both spellings', () => {
    expect(isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true);
    for (const token of [
      '',
      'ExponentPushToken[]',
      'ExponentPushToken[a b]',
      'xxxxxxxxxxxx',
      'ExponentPushToken[x] ',
    ]) {
      expect(isExpoPushToken(token)).toBe(false);
    }
  });

  it('measures the payload in UTF-8 bytes, so the cedi sign counts as three', () => {
    expect(
      pushPayloadBytes({ title: '', body: '₵' }) - pushPayloadBytes({ title: '', body: '' }),
    ).toBe(3);
  });
});
