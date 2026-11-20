import { NextResponse, type NextRequest } from 'next/server';
import {
  contentSecurityPolicy,
  createNonce,
  forwardedRequestHeaders,
  securityHeaders,
} from './lib/security-headers';

/**
 * Runs before every request, static files included, so every response carries the headers.
 * It never logs anything: link URLs carry tokens (CLAUDE.md section 9). The job sheet's photo
 * posts are the exception (`config` below); their routes set the same headers themselves.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === 'development' });
  const response = NextResponse.next({
    request: { headers: forwardedRequestHeaders(request.headers, csp, nonce) },
  });
  response.headers.set('Content-Security-Policy', csp);
  for (const [name, value] of securityHeaders()) response.headers.set(name, value);
  // Link pages show personal documents and money, the unsubscribe page a person's email and the
  // job sheet a tenant's home (M8): never stored by the browser or anything between.
  const { pathname } = request.nextUrl;
  if (/^\/[lpruj]\//.test(pathname)) response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * Every path but the job sheet's two photo posts, `/j/<token>/start` and `/j/<token>/complete`
 * (M8 review LT 1). For a post it runs on, Next.js copies the body for the proxy and cuts it at
 * 10 MB, warning with the URL, token and all; those two carry up to ten 10 MB photos. Their routes
 * read the form within an explicit limit (lib/body-limit.ts) and add the headers (secured()).
 */
export const config = {
  matcher: ['/((?!j/[^/]+/(?:start|complete)$).*)'],
};
