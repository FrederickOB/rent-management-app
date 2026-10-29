import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Actor } from '@rent/domain/policy';
import type { ResolvedSession } from '@rent/server/identity';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    rentSession?: ResolvedSession | null;
  }
}

export interface RequestContext {
  readonly requestId: string;
  readonly headers: Headers;
  readonly session: ResolvedSession | null;
  readonly actor: Actor | null;
}

export function requestContextOf(request: FastifyRequest): RequestContext {
  const session = request.rentSession ?? null;
  return {
    requestId: String(request.id),
    headers: headersOf(request),
    session,
    actor: session?.actor ?? null,
  };
}

/** Injects the request context (request id, session, actor) into a controller method. */
export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  requestContextOf(ctx.switchToHttp().getRequest<FastifyRequest>()),
);

export function headersOf(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return headers;
}
