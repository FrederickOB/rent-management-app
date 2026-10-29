import { connection } from 'next/server';

/** Liveness for CI and the load balancer, answered per request and never cached. */
export async function GET(): Promise<Response> {
  await connection();
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
