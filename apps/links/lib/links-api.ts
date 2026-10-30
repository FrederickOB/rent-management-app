import {
  DEV_LINKS_API_KEY,
  LINK_TOKEN_PATTERN,
  LINKS_API_KEY_HEADER,
  type SigningPage,
} from '@rent/contracts';

/**
 * The links API (M3 plan 4.15), called server to server: the browser never talks to the API,
 * and this module never runs in the browser. apps/links proves who it is with LINKS_API_KEY,
 * which production sets; elsewhere both sides use the shared development key. Nothing here
 * logs: requests carry tokens, codes and signatures (CLAUDE.md section 10).
 */
const API = (process.env.API_BASE_URL ?? 'http://localhost:3700').replace(/\/+$/, '');
const KEY = process.env.LINKS_API_KEY ?? DEV_LINKS_API_KEY;

export { LINK_TOKEN_PATTERN };
export type { SigningPage };

/** The browser behind a request, as this server sees it: evidence for the signing record. */
export interface Client {
  readonly ip: string;
  readonly userAgent: string;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number;
      /** The API's error code, upper case: CODE_WRONG, SIGNING_LOCKED, NOT_FOUND... */
      readonly code: string;
      readonly data: Readonly<Record<string, string>> | null;
    };

async function call<T>(path: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [LINKS_API_KEY_HEADER]: KEY },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, status: 503, code: 'UNAVAILABLE', data: null };
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return { ok: true, value: json as T };
  const data = json?.data;
  return {
    ok: false,
    status: response.status,
    code: typeof json?.code === 'string' ? json.code : 'ERROR',
    data:
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, string>)
        : null,
  };
}

export const openLink = (token: string, client: Client) =>
  call<SigningPage>('/links/open', { token, client });

export const documentLink = (token: string, client: Client) =>
  call<{ url: string }>('/links/document', { token, client });

export const sendCode = (token: string, client: Client) =>
  call<{
    channel: 'sms' | 'email';
    destinationMasked: string;
    expiresAt: string;
    sendsLeft: number;
  }>('/links/code', { token, client });

export const signLink = (
  token: string,
  client: Client,
  signature: {
    readonly code: string;
    readonly method: 'typed' | 'drawn';
    readonly typedName: string | null;
    readonly drawing: string | null;
    readonly consentVersion: string;
    readonly consentAccepted: boolean;
  },
) => call<{ signedAt: string; complete: boolean }>('/links/sign', { token, client, ...signature });

export const declineLink = (token: string, client: Client, reason: string) =>
  call<{ declinedAt: string }>('/links/decline', { token, client, reason });

/**
 * The browser's address: the last X-Forwarded-For entry, which is the one the nearest proxy (the
 * load balancer in front of apps/links, or Next.js itself from the socket) saw. Its device: the
 * User-Agent. Both are evidence on the signature.
 */
export function clientFrom(headers: Headers): Client {
  const forwarded = headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  const ip = forwarded ?? headers.get('x-real-ip') ?? 'unknown';
  return {
    ip: ip.slice(0, 64),
    userAgent: (headers.get('user-agent') ?? 'unknown').slice(0, 500),
  };
}

/** Only well-formed tokens reach the API; anything else is simply not found. */
export const isToken = (token: string): boolean => LINK_TOKEN_PATTERN.test(token);
