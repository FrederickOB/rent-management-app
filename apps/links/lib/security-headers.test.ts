import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, createNonce, forwardedRequestHeaders } from './security-headers';

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(';').map((directive) => {
      const [name = '', ...values] = directive.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe('NFR-SEC secure headers: links policy', () => {
  it('builds the strict production policy around the nonce', () => {
    expect(directives(contentSecurityPolicy('abc'))).toEqual({
      'default-src': ["'none'"],
      'script-src': ["'self'", "'nonce-abc'", "'strict-dynamic'"],
      'style-src': ["'self'", "'nonce-abc'"],
      'img-src': ["'self'", 'data:'],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'base-uri': ["'none'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    });
  });

  it('relaxes only what next dev needs', () => {
    const production = directives(contentSecurityPolicy('abc'));
    const dev = directives(contentSecurityPolicy('abc', { dev: true }));
    expect(dev['script-src']).toEqual([
      "'self'",
      "'nonce-abc'",
      "'strict-dynamic'",
      "'unsafe-eval'",
    ]);
    expect(dev['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect({ ...dev, 'script-src': [], 'style-src': [] }).toEqual({
      ...production,
      'script-src': [],
      'style-src': [],
    });
  });

  it('makes a fresh 128-bit nonce for every call', () => {
    const nonces = new Set(Array.from({ length: 1000 }, () => createNonce()));
    expect(nonces.size).toBe(1000);
    for (const nonce of nonces) expect(atob(nonce)).toHaveLength(16);
  });

  it('drops cookies and overwrites any nonce the client sent', () => {
    const incoming = new Headers({
      cookie: 'session=abc',
      'x-nonce': 'forged',
      'content-security-policy': 'forged',
      accept: 'text/html',
    });
    const forwarded = forwardedRequestHeaders(incoming, 'the-policy', 'the-nonce');
    expect(forwarded.get('cookie')).toBeNull();
    expect(forwarded.get('x-nonce')).toBe('the-nonce');
    expect(forwarded.get('content-security-policy')).toBe('the-policy');
    expect(forwarded.get('accept')).toBe('text/html');
    expect(incoming.get('cookie')).toBe('session=abc');
  });
});
