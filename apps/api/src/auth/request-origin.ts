import type { AppConfig } from '@rent/server/core';

/**
 * Where a request comes from, for the two checks the API makes before any route runs (M11
 * security review, reviewer 3 F1 and reviewer 1 F1 and F7).
 */

/**
 * Fastify's `trustProxy` (R3 F1): only the proxies listed in TRUSTED_PROXIES are believed about
 * the client's address. Fastify then takes the right-most X-Forwarded-For entry that is not one of
 * them, so a client cannot choose its own `request.ip` (which feeds every per-IP limit, the
 * device list and the audit). Unset, X-Forwarded-For is ignored and the socket's address is used;
 * production refuses to start without the list.
 */
export function trustProxyOf(
  config: Pick<AppConfig, 'NODE_ENV' | 'TRUSTED_PROXIES'>,
): string[] | false {
  const list = (config.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (list.length === 0 && config.NODE_ENV === 'production')
    throw new Error('TRUSTED_PROXIES must list the proxies in front of the API in production');
  return list.length > 0 ? list : false;
}

/**
 * The origins the API serves: the staff web app, the tenant app's web build, and the tenant app's
 * scheme (Better Auth's trusted origins; the native app normally sends no Origin at all).
 */
export function trustedOriginsOf(
  config: Pick<AppConfig, 'WEB_ORIGIN' | 'TENANT_WEB_ORIGIN' | 'TENANT_APP_SCHEME'>,
): ReadonlySet<string> {
  return new Set([
    ...[config.WEB_ORIGIN, config.TENANT_WEB_ORIGIN].map((o) => new URL(o).origin),
    `${config.TENANT_APP_SCHEME}://`,
  ]);
}

type HeaderValue = string | string[] | undefined;
type Headers = Record<string, HeaderValue>;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const JSON_TYPE = /^application\/json\s*(;|$)/i;

const first = (value: HeaderValue): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Whether a request carries a body: a declared length above zero, or a chunked one. */
function hasBody(headers: Headers): boolean {
  const length = first(headers['content-length']);
  if (length !== undefined && Number(length) > 0) return true;
  return first(headers['transfer-encoding']) !== undefined;
}

export interface CsrfRefusal {
  readonly status: 403 | 415;
  readonly code: 'FORBIDDEN_ORIGIN' | 'UNSUPPORTED_MEDIA_TYPE';
  readonly message: string;
}

/**
 * CSRF (R1 F7). Cookies are SameSite=Lax, and on top of that every state-changing request must
 * show it is not a cross-site browser request:
 * - a browser's `Origin` must be one of ours (any other is refused, even with a JSON body);
 * - with no `Origin`, a browser's `Sec-Fetch-Site` must be `same-origin` (or `none`, typed by the
 *   person);
 * - the body, if any, must be JSON. HTML forms can only send urlencoded, multipart or plain text,
 *   and a cross-origin JSON request needs a CORS preflight that our CORS policy refuses.
 * A request with neither `Origin` nor `Sec-Fetch-Site` is not from a browser (the Expo native app,
 * the links server, the web app's server): it passes when its body is JSON or empty.
 *
 * It covers the Better Auth mount too, which is where login CSRF happened: a cross-site form could
 * post a phone number and code to /api/auth/phone-number/verify as urlencoded. Webhooks are
 * exempt: providers post form bodies, carry no cookies, and are verified by signature. Health
 * checks are read-only.
 */
export function csrfRefusal(
  method: string,
  path: string,
  headers: Headers,
  trusted: ReadonlySet<string>,
): CsrfRefusal | null {
  if (SAFE_METHODS.has(method.toUpperCase())) return null;
  if (path.startsWith('/webhooks/') || path.startsWith('/health/')) return null;
  const origin = first(headers.origin);
  if (origin !== undefined && origin !== '') {
    if (!trusted.has(origin))
      return {
        status: 403,
        code: 'FORBIDDEN_ORIGIN',
        message: 'This request did not come from the app',
      };
  } else {
    const site = first(headers['sec-fetch-site']);
    if (site !== undefined && site !== 'same-origin' && site !== 'none')
      return {
        status: 403,
        code: 'FORBIDDEN_ORIGIN',
        message: 'This request did not come from the app',
      };
  }
  const type = first(headers['content-type']);
  if (type !== undefined ? !JSON_TYPE.test(type) : hasBody(headers))
    return {
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Send the request as JSON',
    };
  return null;
}
