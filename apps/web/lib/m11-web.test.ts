import { describe, expect, it } from 'vitest';
import { GET } from '../app/health/route';
import { healthBody, HSTS_VALUE, securityHeaders } from './security-headers';

// M11 web: health and headers (plan 4.7 and decision 6).

describe('NFR-AVAIL the web app answers /health without a session', () => {
  it('says it is up, uncached', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'web' });
    expect(healthBody(new Date('2026-11-10T09:00:00.000Z'))).toEqual({
      status: 'ok',
      service: 'web',
      time: '2026-11-10T09:00:00.000Z',
    });
  });
});

describe('NFR-SEC HSTS is sent in production only', () => {
  const hsts = (env: string | undefined) =>
    securityHeaders(env).find((h) => h.key === 'Strict-Transport-Security')?.value ?? null;

  it('adds a year of HSTS in production, without preload or subdomains', () => {
    expect(hsts('production')).toBe(HSTS_VALUE);
    expect(HSTS_VALUE).toBe('max-age=31536000');
    expect(HSTS_VALUE).not.toMatch(/preload|includeSubDomains/);
  });

  it('leaves development and tests without it, and keeps the other headers everywhere', () => {
    expect(hsts('development')).toBeNull();
    expect(hsts('test')).toBeNull();
    expect(hsts(undefined)).toBeNull();
    for (const env of ['production', 'development'])
      expect(securityHeaders(env).map((h) => h.key)).toEqual(
        expect.arrayContaining([
          'Content-Security-Policy',
          'X-Frame-Options',
          'X-Content-Type-Options',
          'Referrer-Policy',
          'Permissions-Policy',
        ]),
      );
  });
});
