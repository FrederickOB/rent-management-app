/** A failed request, in the terms the screens need. `message` is safe to show to people. */
export interface Problem {
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string;
}

export const GENERIC_MESSAGE = 'Something went wrong. Try again.';
export const NETWORK_MESSAGE =
  'We could not reach the server. Check your connection and try again.';
export const SESSION_ENDED_MESSAGE = 'Your session has ended. Sign in again.';
const RATE_LIMITED = 'Too many attempts. Wait a minute and try again.';
const NOT_FOR_STAFF =
  'This app is for tenants. If you work for a landlord or an agency, use the web app instead.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalises errors from the typed API client (oRPC). Handler errors carry a status, an upper-case
 * code and a message meant for people; refusals from the API's guards (401, 403) arrive with
 * their `{ code, message }` body under `data.body`. A failed fetch is a TypeError.
 */
export function toProblem(error: unknown): Problem {
  if (error instanceof TypeError)
    return { status: null, code: 'network', message: NETWORK_MESSAGE };
  if (!isRecord(error)) return { status: null, code: null, message: GENERIC_MESSAGE };
  const status = typeof error.status === 'number' ? error.status : null;
  const body = isRecord(error.data) && isRecord(error.data.body) ? error.data.body : null;
  const code =
    typeof body?.code === 'string' ? body.code : typeof error.code === 'string' ? error.code : null;
  if (status === null) return { status, code, message: GENERIC_MESSAGE };
  if (status === 401) return { status, code, message: SESSION_ENDED_MESSAGE };
  if (status === 403) return { status, code, message: NOT_FOR_STAFF };
  if (status === 429) return { status, code, message: RATE_LIMITED };
  if (status >= 500) return { status, code, message: GENERIC_MESSAGE };
  const own =
    (typeof body?.message === 'string' && body.message) ||
    (typeof error.message === 'string' && error.message) ||
    GENERIC_MESSAGE;
  return { status, code, message: own };
}
