import 'reflect-metadata';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RawRequestDefaultExpression } from 'fastify';
import {
  AUTH,
  createLogger,
  loadConfig,
  NestLogger,
  STORAGE_PORT,
  type CoreOptions,
} from '@rent/server/core';
import type { StoragePort } from '@rent/integrations';
import type { Auth } from '@rent/server/identity';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from './app.module';
import { mountBetterAuth } from './auth/mount-better-auth';
import { csrfRefusal, trustedOriginsOf, trustProxyOf } from './auth/request-origin';
import { ApiExceptionFilter } from './http/errors';

const REQUEST_ID = /^[0-9a-f-]{36}$/i;

/** Builds the API application. Tests pass overrides (database, clock, ports) through `core`. */
export async function createApiApp(core: CoreOptions = {}): Promise<NestFastifyApplication> {
  const config = core.config ?? loadConfig();
  const logger = core.logger ?? createLogger({ level: config.LOG_LEVEL, name: 'api' });

  const adapter = new FastifyAdapter({
    bodyLimit: 1_000_000,
    // M11 review R3 F1: only the listed proxies' X-Forwarded-For is believed, never the client's.
    trustProxy: trustProxyOf(config),
    requestIdHeader: 'x-request-id',
    genReqId: (request: RawRequestDefaultExpression) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : uuidv7();
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({ ...core, config, logger }),
    adapter,
    {
      logger: new NestLogger(logger),
      // Provider webhooks are verified against the exact bytes received (M4b plan 4.4).
      rawBody: true,
    },
  );

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  app.enableCors({ origin: [config.WEB_ORIGIN, config.TENANT_WEB_ORIGIN], credentials: true });
  app.useGlobalFilters(new ApiExceptionFilter(logger));

  const fastify = app.getHttpAdapter().getInstance();
  // M11 review R1 F7: state-changing requests must come from our origins and carry JSON.
  const trusted = trustedOriginsOf(config);
  fastify.addHook('onRequest', async (request, reply) => {
    const refusal = csrfRefusal(
      request.method,
      request.url.split('?')[0] ?? '/',
      request.headers,
      trusted,
    );
    if (refusal)
      return reply.code(refusal.status).send({ code: refusal.code, message: refusal.message });
  });
  fastify.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', String(request.id));
  });
  fastify.addHook('onResponse', async (request, reply) => {
    // Route template only: raw paths can carry tokens, and bodies are never logged.
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
        ms: Math.trunc(reply.elapsedTime),
      },
      'request',
    );
  });
  mountBetterAuth(fastify, app.get<Auth>(AUTH), config);
  // Idempotent. Deployed environments create buckets with infrastructure; this covers local and CI.
  await app
    .get<StoragePort>(STORAGE_PORT)
    .ensureBuckets({ files: config.S3_BUCKET_FILES, evidence: config.S3_BUCKET_EVIDENCE })
    .catch((error: unknown) => logger.warn({ err: error }, 'could not ensure storage buckets'));

  // Decision 3 (OQ-03): config refuses a live key without the switch; when it is on, the log
  // records who turned it on (never the key).
  if (config.LIVE_RENT_COLLECTION === 'enabled')
    logger.warn(
      { liveRentCollection: true, enabledBy: config.LIVE_RENT_COLLECTION_ENABLED_BY },
      'live rent collection is enabled',
    );
  await app.init();
  return app;
}
