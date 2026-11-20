import type { AppLogger } from './logging/logger';

/**
 * The database pool's error listener (createDatabase's `onError`), through the process's logger:
 * Postgres ended an idle pooled connection (a restart, a failover, an administrator). The pool
 * has dropped it and the next query opens another, so this is a warning, never a crash. Only the
 * error's code is logged: never the message's connection details, the host or the user.
 */
export function poolErrorLogger(logger: AppLogger): (error: Error) => void {
  return (error) => {
    const code = (error as { code?: unknown }).code;
    // `errorCode`, not `code`: the log scrubber masks every `code` (one-time codes).
    logger.warn(
      { errorCode: typeof code === 'string' ? code : 'unknown' },
      'database connection ended',
    );
  };
}
