import {
  DEV_LINKS_API_KEY,
  LINK_TOKEN_PATTERN,
  LINKS_API_KEY_HEADER,
  type JobSheetView,
  type PayIntent,
  type PayPage,
  type ReceiptPage,
  type SigningPage,
  type UnsubscribePage,
} from '@rent/contracts';
import { PEER_ADDRESS_HEADER } from './peer-address';

/**
 * The links API (M3 plan 4.15; M4b plan 4.3 and 4.6), called server to server: the browser never talks to the API,
 * and this module never runs in the browser. apps/links proves who it is with LINKS_API_KEY,
 * which production sets; elsewhere both sides use the shared development key. Nothing here
 * logs: requests carry tokens, codes and signatures (CLAUDE.md section 10).
 */
const API = (process.env.API_BASE_URL ?? 'http://localhost:3700').replace(/\/+$/, '');
const KEY = process.env.LINKS_API_KEY ?? DEV_LINKS_API_KEY;

export { LINK_TOKEN_PATTERN };
export type { JobSheetView, PayIntent, PayPage, ReceiptPage, SigningPage, UnsubscribePage };

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
 * The browser's address and device: evidence on the signature, and the key for rate limits.
 *
 * - **Behind the edge** (production): only the header the edge overwrites with the address it saw,
 *   named by CLIENT_IP_HEADER. Production refuses to start without it (instrumentation.ts).
 *   **It carries one address, overwritten by the edge.** A list means something appended to it
 *   instead, so only its last entry counts, the one added nearest this server (M11 review).
 * - **With no edge** (development, CI): the connection's own address, which this server stamps on
 *   every request (lib/peer-address.ts).
 *
 * A value that is not an IP address counts as unknown. X-Forwarded-For is never trusted in a
 * running server: Next.js fills it from the socket only when the request has none, so otherwise it
 * is whatever the client wrote (M11 security review F8). Code that runs outside the server, unit
 * tests calling a route, has neither header, and gets the last X-Forwarded-For entry as before.
 */
export function clientFrom(
  headers: Headers,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Client {
  const configured = env.CLIENT_IP_HEADER?.trim().toLowerCase();
  const ip =
    oneAddress(configured ? headers.get(configured) : headers.get(PEER_ADDRESS_HEADER)) ??
    (configured ? null : oneAddress(headers.get('x-forwarded-for'))) ??
    'unknown';
  return {
    ip,
    userAgent: (headers.get('user-agent') ?? 'unknown').slice(0, 500),
  };
}

/** One IPv4 or IPv6 address from a header: the last entry of a list, if it looks like one. */
function oneAddress(value: string | null): string | null {
  const last = value
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return last && /^[0-9A-Fa-f:.]{2,45}$/.test(last) && /[.:]/.test(last) ? last : null;
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

// The artisan's job sheet (MI-04, MI-06; M8 decision 6): the token is the only authorisation.

export const openJobSheet = (token: string, client: Client) =>
  call<JobSheetView>('/job-sheets/open', { token, client });

/** Whether the sheet is live (not closed, expired or replaced); records nothing (M11 review B13). */
export const checkJobSheet = (token: string, client: Client) =>
  call<{ live: boolean }>('/job-sheets/check', { token, client });

export const respondJobSheet = (
  token: string,
  client: Client,
  response: 'accepted' | 'declined',
  reason: string | null,
) => call<JobSheetView>('/job-sheets/respond', { token, client, response, reason });

/** A presigned post for one photo, under the job-media limits (decision 2). */
export const createJobSheetUpload = (
  token: string,
  client: Client,
  file: { readonly contentType: string; readonly sizeBytes: number },
) =>
  call<{ uploadId: string; url: string; fields: Record<string, string>; expiresAt: string }>(
    '/job-sheets/uploads',
    { token, client, contentType: file.contentType, sizeBytes: file.sizeBytes },
  );

export const startJobSheet = (
  token: string,
  client: Client,
  start: { readonly uploadIds: readonly string[]; readonly beforePhotoReason: string | null },
) => call<JobSheetView>('/job-sheets/start', { token, client, ...start });

export const sendJobSheetCode = (token: string, client: Client) =>
  call<{ destinationMasked: string; expiresAt: string; sendsLeft: number }>('/job-sheets/code', {
    token,
    client,
  });

export const completeJobSheet = (
  token: string,
  client: Client,
  completion: {
    readonly code: string;
    readonly uploadIds: readonly string[];
    readonly completionNote: string;
  },
) => call<JobSheetView>('/job-sheets/complete', { token, client, ...completion });

/** A 5-minute link to one of the job's files. */
export const jobSheetAttachment = (token: string, client: Client, attachmentId: string) =>
  call<{ url: string }>('/job-sheets/attachment', { token, client, attachmentId });

// The email unsubscribe link (CM-09; M6 decision 7): the token is the only authorisation.

/** What the link would stop, or that it already has: nothing changes on opening. */
export const openUnsubscribe = (token: string, client: Client) =>
  call<UnsubscribePage>('/links/unsubscribe/open', { token, client });

/** Withdraws email consent for the link's person and landlord. Idempotent. */
export const confirmUnsubscribe = (token: string, client: Client) =>
  call<UnsubscribePage>('/links/unsubscribe/confirm', { token, client });

/**
 * The card return page (M4b review 14): the provider sends the payer to
 * `/p/return?reference=…`, with the charge's reference and no pay-link token. The answer is the
 * payment's status and receipt number only, never the invoice or the tenant.
 */
export const payReturned = (reference: string, client: Client) =>
  call<{
    status: PayIntent['status'];
    receiptNumber: string | null;
    message: string | null;
    failureCode: string | null;
  }>('/links/pay/return', { reference, client });
