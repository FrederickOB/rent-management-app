import { NextResponse, type NextRequest } from 'next/server';
import {
  contentSecurityPolicy,
  createNonce,
  forwardedRequestHeaders,
  SECURITY_HEADERS,
} from './lib/security-headers';

/**
 * Runs before every request, static files included, so every response carries the headers.
 * It never logs anything: link URLs carry tokens (CLAUDE.md section 9).
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === 'development' });
  const response = NextResponse.next({
    request: { headers: forwardedRequestHeaders(request.headers, csp, nonce) },
  });
  response.headers.set('Content-Security-Policy', csp);
  for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
  return response;
}
