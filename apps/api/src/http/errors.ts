import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ORPCError } from '@orpc/server';
import { DomainError } from '@rent/domain/errors';
import { AppError, type AppLogger } from '@rent/server/core';
import type { FastifyReply } from 'fastify';

/** Maps our errors to oRPC errors inside contract handlers, so clients get typed failures. */
export function toORPCError(error: unknown): unknown {
  if (error instanceof AppError)
    return new ORPCError(error.code.toUpperCase(), {
      status: error.status,
      message: error.message,
    });
  if (error instanceof DomainError)
    return new ORPCError(error.code.toUpperCase(), { status: 422, message: error.message });
  return error;
}

/** JSON errors for everything outside the contracts: `{ code, message }`. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (error instanceof AppError) {
      void reply.status(error.status).send({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof DomainError) {
      void reply.status(422).send({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof HttpException) {
      void reply.status(error.getStatus()).send({ code: 'http_error', message: error.message });
      return;
    }
    this.logger.error({ err: error }, 'unhandled error');
    void reply.status(500).send({ code: 'internal_error', message: 'Something went wrong' });
  }
}
