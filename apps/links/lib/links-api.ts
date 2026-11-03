import {
  DEV_LINKS_API_KEY,
  LINK_TOKEN_PATTERN,
  LINKS_API_KEY_HEADER,
  type INTENT_STATUSES,
  type PayPage,
  type ReceiptPage,
  type SigningPage,
} from '@rent/contracts';

/**
 * The links API (M3 plan 4.15; M4b plan 4.3 and 4.6), called server to server: the browser never talks to the API,
 * and this module never runs in the browser. apps/links proves who it is with LINKS_API_KEY,
 * which production sets; elsewhere both sides use the shared development key. Nothing here
 * logs: requests carry tokens, codes and signatures (CLAUDE.md section 10).
 */
const API = (process.env.API_BASE_URL ?? 'http://localhost:3700').replace(/\/+$/, '');
const KEY = process.env.LINKS_API_KEY ?? DEV_LINKS_API_KEY;

export { LINK_TOKEN_PATTERN };
export type { PayPage, ReceiptPage, SigningPage };

/** A payment started from a pay link, as the API reports it (the contract's intent schema). */
export interface PayIntent {
  readonly intentId: string;
  readonly status: (typeof INTENT_STATUSES)[number];
  readonly amountMinor: number;
  /** Card payments continue on the provider's checkout page. */
  readonly checkoutUrl: string | null;
  /** For example "Approve the payment on your phone". */
  readonly message: string | null;
  readonly receiptNumber: string | null;
}

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

// Pay links (BC-04; M4b plan 4.3). The token is the only authorisation, as for signing.

export const openPay = (token: string, client: Client) =>
  call<PayPage>('/links/pay/open', { token, client });

/** Starts a MoMo prompt or a card checkout. The submission id makes a double tap one charge. */
export const startPay = (
  token: string,
  client: Client,
  payment: {
    readonly amountMinor: number;
    readonly method: 'momo' | 'card';
    readonly momo: { readonly phone: string; readonly network: string } | null;
    readonly submissionId: string;
  },
) => call<PayIntent>('/links/pay/intents', { token, client, ...payment });

/** A payment's status; the API asks the provider when it is still pending. */
export const payStatus = (token: string, client: Client, intentId: string) =>
  call<PayIntent>('/links/pay/status', { token, client, intentId });

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

/** A fresh 5-minute link to the invoice PDF the pay link is for (BC-09's first reminder). */
export const payInvoiceDocument = (token: string, client: Client) =>
  call<{ url: string }>('/links/pay/invoice', { token, client });

// Receipt links (BC-06; M4b plan 4.6): a 30-day link to one receipt, served as 5-minute downloads.

export const openReceipt = (token: string, client: Client) =>
  call<ReceiptPage>('/links/receipt/open', { token, client });

export const receiptDocument = (token: string, client: Client) =>
  call<{ url: string }>('/links/receipt/document', { token, client });
