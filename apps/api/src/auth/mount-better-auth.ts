import type { AppConfig } from '@rent/server/core';
import { AUTH_BASE_PATH, isAllowedAuthPath, type Auth } from '@rent/server/identity';
import type { FastifyInstance } from 'fastify';

const DROP = new Set(['content-length', 'transfer-encoding', 'connection', 'x-rent-client-ip']);

/**
 * Serves Better Auth at /api/auth/* on the Fastify instance under NestJS (ADR-011). Only the
 * allowlisted endpoints reach Better Auth. The client IP header is set here from `request.ip`:
 * the socket's address, or X-Forwarded-For only behind a proxy in TRUSTED_PROXIES (M11 review R3
 * F1), never a value the client chose. The CSRF check in app.ts runs before this route.
 */
export function mountBetterAuth(fastify: FastifyInstance, auth: Auth, config: AppConfig): void {
  fastify.route({
    method: ['GET', 'POST'],
    url: `${AUTH_BASE_PATH}/*`,
    async handler(request, reply) {
      const url = new URL(request.url, config.API_BASE_URL);
      const relative = url.pathname.slice(AUTH_BASE_PATH.length) || '/';
      if (!isAllowedAuthPath(relative))
        return reply.code(404).send({ code: 'not_found', message: 'Not found' });

      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined || DROP.has(key)) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
      }
      headers.set('x-rent-client-ip', request.ip);
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      if (hasBody) headers.set('content-type', 'application/json');

      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          body: hasBody ? JSON.stringify(request.body ?? {}) : undefined,
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') void reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) void reply.header('set-cookie', cookies);
      return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
    },
  });
}
