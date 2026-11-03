import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { DEV_LINKS_API_KEY, LINKS_API_KEY_HEADER } from '@rent/contracts';
import { AppError, CONFIG, type AppConfig } from '@rent/server/core';
import type { FastifyRequest } from 'fastify';

/**
 * The links API is called only by apps/links, server to server (M3 plan 4.15). It proves who it
 * is with a shared key in a header, compared in constant time. The key is LINKS_API_KEY, which
 * production requires; elsewhere both sides fall back to the same development key.
 */
@Injectable()
export class LinksKeyGuard implements CanActivate {
  private readonly key: Buffer;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.key = Buffer.from(config.LINKS_API_KEY ?? DEV_LINKS_API_KEY, 'utf8');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const sent = request.headers[LINKS_API_KEY_HEADER];
    const given = Buffer.from(typeof sent === 'string' ? sent : '', 'utf8');
    if (given.length !== this.key.length || !timingSafeEqual(given, this.key))
      throw new AppError(401, 'links_key', 'This endpoint is for the links app only');
    return true;
  }
}
