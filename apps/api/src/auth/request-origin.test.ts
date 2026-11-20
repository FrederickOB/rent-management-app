import { describe, expect, it } from 'vitest';
import { csrfRefusal, trustedOriginsOf, trustProxyOf } from './request-origin';

const trusted = trustedOriginsOf({
  WEB_ORIGIN: 'https://app.example.invalid',
  TENANT_WEB_ORIGIN: 'https://tenant.example.invalid',
  TENANT_APP_SCHEME: 'rentplatform',
});

describe('NFR-SEC M11 review R3 F1: trustProxy comes from TRUSTED_PROXIES only', () => {
  it('trusts the listed proxies, and nothing when the list is empty outside production', () => {
    expect(
      trustProxyOf({ NODE_ENV: 'production', TRUSTED_PROXIES: '10.0.0.0/8, 172.16.0.5' }),
    ).toEqual(['10.0.0.0/8', '172.16.0.5']);
    expect(trustProxyOf({ NODE_ENV: 'development', TRUSTED_PROXIES: undefined })).toBe(false);
    expect(trustProxyOf({ NODE_ENV: 'test', TRUSTED_PROXIES: ' , ' })).toBe(false);
  });

  it('refuses to start production without the list (it used to trust every X-Forwarded-For)', () => {
    expect(() => trustProxyOf({ NODE_ENV: 'production', TRUSTED_PROXIES: undefined })).toThrow(
      /TRUSTED_PROXIES/,
    );
  });
});

describe('NFR-SEC M11 review R1 F7: CSRF on state-changing requests', () => {
  const json = { 'content-type': 'application/json' };

  it('lets our apps, the native app and servers through with JSON or no body', () => {
    expect(
      csrfRefusal('POST', '/me', { ...json, origin: 'https://app.example.invalid' }, trusted),
    ).toBeNull();
    expect(
      csrfRefusal('POST', '/me', { ...json, origin: 'https://tenant.example.invalid' }, trusted),
    ).toBeNull();
    expect(
      csrfRefusal('POST', '/api/auth/sign-out', { 'sec-fetch-site': 'same-origin' }, trusted),
    ).toBeNull();
    // Expo native and the links server send no Origin and no Sec-Fetch-Site.
    expect(
      csrfRefusal(
        'POST',
        '/api/auth/phone-number/verify',
        { ...json, 'expo-origin': 'rentplatform://' },
        trusted,
      ),
    ).toBeNull();
    expect(csrfRefusal('POST', '/links/pay/open', json, trusted)).toBeNull();
    expect(csrfRefusal('POST', '/approvals/x/cancel', {}, trusted)).toBeNull();
    expect(csrfRefusal('GET', '/me', { origin: 'https://evil.example' }, trusted)).toBeNull();
  });

  it('refuses another origin, a cross-site fetch, and form or text bodies', () => {
    expect(
      csrfRefusal('POST', '/me', { ...json, origin: 'https://evil.example' }, trusted),
    ).toMatchObject({ status: 403 });
    expect(csrfRefusal('DELETE', '/x', { 'sec-fetch-site': 'cross-site' }, trusted)).toMatchObject({
      status: 403,
    });
    expect(
      csrfRefusal('POST', '/x', { ...json, 'sec-fetch-site': 'same-site' }, trusted),
    ).toMatchObject({ status: 403 });
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=a',
      'text/plain',
    ])
      expect(
        csrfRefusal(
          'POST',
          '/api/auth/phone-number/verify',
          { 'content-type': type, origin: 'https://app.example.invalid' },
          trusted,
        ),
        type,
      ).toMatchObject({ status: 415 });
    expect(csrfRefusal('POST', '/x', { 'content-length': '12' }, trusted)).toMatchObject({
      status: 415,
    });
  });

  it('leaves webhooks, which post forms and carry no cookies, to their signatures', () => {
    expect(
      csrfRefusal(
        'POST',
        '/webhooks/sms/inbound',
        { 'content-type': 'application/x-www-form-urlencoded' },
        trusted,
      ),
    ).toBeNull();
  });
});
