/**
 * Response headers for every apps/links response (CLAUDE.md section 9). The proxy applies them,
 * except on the job sheet's two photo posts, which the proxy never sees (proxy.ts): those routes
 * wrap their answers in secured().
 */

/** A fresh 128-bit nonce for each request, base64 encoded as CSP expects. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export interface PolicyOptions {
  /** `next dev` needs eval for React's error overlay and inline styles for its own UI. */
  readonly dev?: boolean;
}

/** A strict, nonce-based policy. Anything not listed falls back to default-src 'none'. */
export function contentSecurityPolicy(nonce: string, { dev = false }: PolicyOptions = {}): string {
  const directives: string[][] = [
    ['default-src', "'none'"],
    // 'strict-dynamic' trusts the chunks the nonce-carrying Next.js runtime loads; browsers
    // without CSP level 3 ignore it and fall back to 'self'.
    [
      'script-src',
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    ['style-src', "'self'", dev ? "'unsafe-inline'" : `'nonce-${nonce}'`],
    ['img-src', "'self'", 'data:'],
    ['font-src', "'self'"],
    ['connect-src', "'self'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ];
  return directives.map((directive) => directive.join(' ')).join('; ');
}

/** The other security headers, identical on every response. */
export const SECURITY_HEADERS: readonly (readonly [name: string, value: string])[] = [
  // Link URLs carry tokens, so they must never travel on in a Referer header.
  ['Referrer-Policy', 'no-referrer'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
  // frame-ancestors covers current browsers; this covers older Android WebViews.
  ['X-Frame-Options', 'DENY'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  // A token URL that leaks must never end up in a search index.
  ['X-Robots-Tag', 'noindex, nofollow'],
];

/**
 * The request headers routes see. Cookies are dropped, so nothing in this app can read one. The
 * nonce travels in the CSP header, where Next.js reads it for its own scripts, and in x-nonce for
 * our components. Both overwrite whatever the client sent.
 */
export function forwardedRequestHeaders(incoming: Headers, csp: string, nonce: string): Headers {
  const headers = new Headers(incoming);
  headers.delete('cookie');
  headers.set('content-security-policy', csp);
  headers.set('x-nonce', nonce);
  return headers;
}

/**
 * The proxy's headers, for a response the proxy does not see (the job sheet's photo posts): a
 * policy with a nonce of its own, the other security headers, and no caching.
 */
export function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', contentSecurityPolicy(createNonce()));
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}
