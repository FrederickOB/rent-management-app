import { healthBody } from '@/lib/security-headers';

/**
 * Liveness for the uptime monitor (NFR-AVAIL; M11 4.7). Outside the signed-in app, so it needs no
 * session; it says the web app answers, and nothing about the API (that has its own `/health`).
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(healthBody(new Date()), { headers: { 'Cache-Control': 'no-store' } });
}
