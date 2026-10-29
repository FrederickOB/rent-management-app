import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import { scrub, scrubString } from './redact';

export type AppLogger = Logger;

/**
 * Structured JSON logs. Every log object and message passes through the scrubber before it is
 * written, so personal data cannot reach the log stream even by mistake.
 */
export function createLogger(
  options: { level?: string; destination?: DestinationStream; name?: string } = {},
): AppLogger {
  return pino(
    {
      name: options.name ?? 'rent',
      level: options.level ?? 'info',
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => scrub(object) as Record<string, unknown>,
      },
      serializers: {
        err: (error: unknown) => scrub(error),
        error: (error: unknown) => scrub(error),
      },
      hooks: {
        logMethod(args, method) {
          const safe = args.map((a) => (typeof a === 'string' ? scrubString(a) : a));
          return method.apply(this, safe as Parameters<typeof method>);
        },
      },
    },
    options.destination,
  );
}

/** Adapts the logger to NestJS's LoggerService. */
export class NestLogger implements LoggerService {
  constructor(private readonly logger: AppLogger) {}
  log(message: unknown, context?: string) {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }
}
