import { readFileSync } from 'node:fs';
import path from 'node:path';

/** One request a replayed adapter made. */
export interface ReplayedCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface ReplayRoute {
  readonly status?: number;
  /** A fixture file, relative to the fixtures folder; or raw bytes for a media download. */
  readonly file?: string;
  readonly bytes?: Buffer;
  readonly contentType?: string;
}

/**
 * A `fetch` that answers from recorded fixtures by method and path, with its query when a route
 * names one (M4b decision
 * 4, M6 decision 14): no request leaves the machine. Anything else is a 404, as providers answer.
 */
export function replayFetch(folder: string, routes: Record<string, ReplayRoute>) {
  const calls: ReplayedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const text = init?.body ? String(init.body) : undefined;
    const body: unknown = (() => {
      try {
        return text === undefined ? undefined : JSON.parse(text);
      } catch {
        return text;
      }
    })();
    calls.push({ method, url, headers: new Headers(init?.headers), body });
    const route =
      routes[`${method} ${url.pathname}${url.search}`] ??
      routes[`${method} ${url.origin}${url.pathname}`] ??
      routes[`${method} ${url.pathname}`];
    if (!route) return new Response('{"error":{"code":404}}', { status: 404 });
    if (route.bytes)
      return new Response(new Uint8Array(route.bytes), {
        status: route.status ?? 200,
        headers: { 'content-type': route.contentType ?? 'application/octet-stream' },
      });
    return new Response(readFileSync(path.join(folder, route.file ?? ''), 'utf8'), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export const readFixture = (folder: string, file: string): unknown =>
  JSON.parse(readFileSync(path.join(folder, file), 'utf8'));
