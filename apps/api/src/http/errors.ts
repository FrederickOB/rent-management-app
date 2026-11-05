import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ORPCError } from '@orpc/server';
import { DomainError } from '@rent/domain/errors';
import {
  AppError,
  conflict,
  noticeCheckConflict,
  registerCheckConflict,
  sqlStateOf,
  type AppLogger,
} from '@rent/server/core';
import type { FastifyReply } from 'fastify';

/**
 * A backstop for database refusals a service did not map where they happen: a unique key taken
 * at the same moment by another request, or a commit-time register check. They become safe 409s;
 * the database's own message, which names tables, keys and ids, is never sent.
 */
function fromDatabase(error: unknown): AppError | null {
  if (error instanceof AppError || error instanceof DomainError || error instanceof ORPCError)
    return null;
  const check = registerCheckConflict(error) ?? noticeCheckConflict(error);
  if (check) return check;
  if (sqlStateOf(error) === '23505')
    return conflict(
      'changed_meanwhile',
      'This was changed at the same time by someone else. Reload the page and try again.',
    );
  return null;
}

/** Maps our errors to oRPC errors inside contract handlers, so clients get typed failures. */
export function toORPCError(error: unknown): unknown {
  const known = fromDatabase(error) ?? error;
  if (known instanceof AppError)
    return new ORPCError(known.code.toUpperCase(), {
      status: known.status,
      message: known.message,
      ...(known.details ? { data: known.details } : {}),
    });
  if (known instanceof DomainError)
    return new ORPCError(known.code.toUpperCase(), { status: 422, message: known.message });
  return known;
}

/** JSON errors for everything outside the contracts: `{ code, message, details? }`. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const known = fromDatabase(error) ?? error;
    if (known instanceof AppError) {
      void reply.status(known.status).send({
        code: known.code,
        message: known.message,
        ...(known.details ? { details: known.details } : {}),
      });
      return;
    }
    if (known instanceof DomainError) {
      void reply.status(422).send({ code: known.code, message: known.message });
      return;
    }
    if (known instanceof HttpException) {
      void reply.status(known.getStatus()).send({ code: 'http_error', message: known.message });
      return;
    }
    this.logger.error({ err: known }, 'unhandled error');
    void reply.status(500).send({ code: 'internal_error', message: 'Something went wrong' });
  }
}
