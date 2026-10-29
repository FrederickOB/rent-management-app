import { describe, expect, it } from 'vitest';
import { clientFrom, isToken } from './links-api';
import { backToPage, seeOther } from './redirect';

describe('TL-07 signing page: what apps/links tells the API', () => {
  it('takes the address the nearest proxy saw, and the device, as evidence', () => {
    expect(
      clientFrom(
        new Headers({
          'x-forwarded-for': '198.51.100.1, 203.0.113.9',
          'user-agent': 'Mozilla/5.0 (Linux; Android 13)',
        }),
      ),
    ).toEqual({ ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (Linux; Android 13)' });
    expect(clientFrom(new Headers())).toEqual({ ip: 'unknown', userAgent: 'unknown' });
    expect(clientFrom(new Headers({ 'user-agent': 'x'.repeat(900) })).userAgent).toHaveLength(500);
  });

  it('passes only well-formed tokens on', () => {
    expect(isToken('A'.repeat(43))).toBe(true);
    expect(isToken('A'.repeat(42))).toBe(false);
    expect(isToken(`${'A'.repeat(42)}/`)).toBe(false);
  });

  it('answers form posts with a 303 back to the page, uncached, on this host', () => {
    const token = 'b'.repeat(43);
    const back = backToPage(token, { error: 'CODE_WRONG', left: '3', draw: null });
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(`/l/${token}?error=CODE_WRONG&left=3#sign`);
    expect(back.headers.get('cache-control')).toBe('no-store');
    expect(backToPage(token, { done: 'signed' }, '').headers.get('location')).toBe(
      `/l/${token}?done=signed`,
    );
    expect(seeOther('/l/x').headers.get('set-cookie')).toBeNull();
  });
});
