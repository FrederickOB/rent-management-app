/**
 * The web app's response headers (next.config.ts). No script policy here: Next.js needs inline
 * scripts and eval in development. The strict, nonce-based policy belongs to apps/links; this one
 * stops framing and base or plugin abuse.
 *
 * M11 decision 6 (NFR-SEC): HSTS in production only. A year, without `includeSubDomains` or
 * `preload`, which are hard to undo; browsers ignore it on plain HTTP, so a local production
 * build is unaffected.
 */
export const HSTS_VALUE = 'max-age=31536000';

export interface Header {
  readonly key: string;
  readonly value: string;
}

export function securityHeaders(nodeEnv: string | undefined): Header[] {
  return [
    {
      key: 'Content-Security-Policy',
      value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
    },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // The set-password link carries its token in the query string; never send it elsewhere.
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    ...(nodeEnv === 'production' ? [{ key: 'Strict-Transport-Security', value: HSTS_VALUE }] : []),
  ];
}

/** What `/health` answers (NFR-AVAIL, M11 4.7): the web app is up. It checks nothing behind it. */
export function healthBody(now: Date): { status: 'ok'; service: 'web'; time: string } {
  return { status: 'ok', service: 'web', time: now.toISOString() };
}
