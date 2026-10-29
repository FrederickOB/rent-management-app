import type { OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http';

/**
 * apps/links never sets a cookie (CLAUDE.md section 9). The proxy runs before a route renders,
 * so it cannot remove a header added later; this guard drops Set-Cookie where Node writes
 * response headers, whatever tries to add one.
 */

type HeaderList = OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined;
type WriteHead = (this: ServerResponse, ...args: unknown[]) => ServerResponse;

const GUARDED = Symbol.for('rent.links.set-cookie-guard');

function isSetCookie(name: unknown): boolean {
  return typeof name === 'string' && name.toLowerCase() === 'set-cookie';
}

/** A writeHead header list without Set-Cookie: an object, a flat list or [name, value] pairs. */
function withoutSetCookie(headers: HeaderList, onDrop: () => void): HeaderList {
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      const pairs = headers.filter((pair) => !(Array.isArray(pair) && isSetCookie(pair[0])));
      if (pairs.length < headers.length) onDrop();
      return pairs;
    }
    const flat: OutgoingHttpHeader[] = [];
    for (let i = 0; i < headers.length; i += 2) {
      if (isSetCookie(headers[i])) {
        onDrop();
        continue;
      }
      // An odd-length list stays odd, so Node still rejects it as it would without the guard.
      flat.push(...headers.slice(i, i + 2));
    }
    return flat;
  }
  if (headers && Object.keys(headers).some(isSetCookie)) {
    onDrop();
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !isSetCookie(name)));
  }
  return headers;
}

function warnDropped(): void {
  // Never the cookie itself: only that something tried to set one.
  console.warn('[links] dropped a Set-Cookie header: this host never sets cookies');
}

/**
 * Patches a ServerResponse prototype: the global one at start-up, a subclass in tests. Installing
 * twice is a no-op, so a dev server that registers again does not wrap the methods twice.
 */
export function installSetCookieGuard(
  prototype: ServerResponse,
  onDrop: () => void = warnDropped,
): void {
  const marks = prototype as unknown as Record<symbol, boolean | undefined>;
  if (marks[GUARDED]) return;
  Object.defineProperty(prototype, GUARDED, { value: true });

  const { setHeader, appendHeader } = prototype;
  const writeHead = prototype.writeHead as WriteHead;

  prototype.setHeader = function (name, value) {
    if (isSetCookie(name)) {
      onDrop();
      return this;
    }
    return setHeader.call(this, name, value);
  };
  prototype.appendHeader = function (name, value) {
    if (isSetCookie(name)) {
      onDrop();
      return this;
    }
    return appendHeader.call(this, name, value);
  };
  // writeHead(status[, reason][, headers]) writes its headers directly when nothing was set before.
  const guardedWriteHead: WriteHead = function (statusCode, reasonOrHeaders, headers) {
    return typeof reasonOrHeaders === 'string'
      ? writeHead.call(
          this,
          statusCode,
          reasonOrHeaders,
          withoutSetCookie(headers as HeaderList, onDrop),
        )
      : writeHead.call(this, statusCode, withoutSetCookie(reasonOrHeaders as HeaderList, onDrop));
  };
  prototype.writeHead = guardedWriteHead as ServerResponse['writeHead'];
}
