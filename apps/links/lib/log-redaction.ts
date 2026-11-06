import { format } from 'node:util';

/**
 * Every URL on this host can carry a link token (CLAUDE.md section 9), and Next.js writes some
 * URLs into its own warnings and errors (a request body over its proxy limit, for one). This
 * replaces the token in any link path, `/l/`, `/p/`, `/r/`, `/u/` or `/j/`, before a line is
 * written, the same way the domain's `redactLinkTokens` keeps tokens out of stored messages.
 */
const TOKEN_PATH = /\/([lpruj])\/[A-Za-z0-9_-]{16,}/g;

export const redactTokens = (text: string): string => text.replace(TOKEN_PATH, '/$1/[link]');

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
const INSTALLED = Symbol.for('rent.links.log-redaction');

type Writable = Pick<Console, (typeof METHODS)[number]>;

/**
 * Wraps the console's writers so each line is formatted first (errors with their stack, objects
 * as Node prints them) and then has its tokens replaced. Installed once, at server start
 * (instrumentation.ts); a second call changes nothing.
 */
export function installLogRedaction(target: Writable = console): void {
  const marked = target as Writable & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return;
  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(redactTokens(format(...args)));
  }
  marked[INSTALLED] = true;
}
