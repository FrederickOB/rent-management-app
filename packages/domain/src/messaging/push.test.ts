import { describe, expect, it } from 'vitest';
import { MESSAGE_PURPOSES } from './messaging';
import { pushNotice } from './push';

describe('CM-09 push notices (decision 5)', () => {
  it('names what arrived and who from, never an amount, a link or an address', () => {
    for (const purpose of MESSAGE_PURPOSES) {
      const notice = pushNotice(purpose, 'Osu Ridge');
      expect(notice.body).toContain('Osu Ridge');
      expect(`${notice.title} ${notice.body}`).not.toMatch(/GH₵|\d|https?:|@/);
    }
    expect(pushNotice('receipt', 'Osu Ridge').screen).toBe('receipt');
    expect(pushNotice('signing_link', 'Osu Ridge').screen).toBe('to_sign');
  });
});
