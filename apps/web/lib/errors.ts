import { DOCUMENT_SCAN_ERRORS } from '@rent/contracts';
/** A failed request, in the terms the screens need. `message` is safe to show to people. */
export interface Problem {
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string;
}

export const GENERIC_MESSAGE = 'Something went wrong. Try again.';
const NETWORK_MESSAGE = 'We could not reach the server. Check your connection and try again.';
const RATE_LIMITED = 'Too many attempts. Wait a minute and try again.';

/**
 * M10 decisions 11 and 12: a staff change refused while the company is read-only (403
 * `SUBSCRIPTION_READ_ONLY`), either for an unpaid subscription or after it has ended. The refusal
 * does not say which, so neither is claimed. Tenants are never affected.
 */
export const READ_ONLY_TEXT =
  'Nothing was changed: your company is read-only for staff, because the subscription is past due or has ended. Tenants can still pay rent and get receipts. If it is past due, paying restores full access at once.';

/**
 * M11 decision 6 (NFR-SEC): an upload is scanned for malware before anyone but its uploader can
 * open it. Every route that serves an uploaded file refuses while the scan is pending (409
 * `DOCUMENT_SCAN_PENDING`: try again) and refuses a quarantined file for good (410
 * `DOCUMENT_QUARANTINED`: never offered).
 */
export const SCAN_PENDING_TEXT =
  'Being checked for viruses: it opens once the check is done. Try again in a moment.';
export const QUARANTINED_TEXT =
  'This file was blocked because it failed the virus check, so it can’t be opened. Ask for a clean copy.';

/**
 * Which scan refusal this is, if any (`DOCUMENT_SCAN_ERRORS` in the contracts). Contract routes
 * send the code in capitals and plain-JSON routes in lower case, so it is compared without case.
 */
export function scanRefusal(error: unknown): 'pending' | 'quarantined' | null {
  const code = errorCode(error);
  if (code === DOCUMENT_SCAN_ERRORS.pending.code.toUpperCase()) return 'pending';
  if (code === DOCUMENT_SCAN_ERRORS.quarantined.code.toUpperCase()) return 'quarantined';
  return null;
}

/** The API's read-only refusal (403 `SUBSCRIPTION_READ_ONLY`). */
export function isReadOnlyRefusal(error: unknown): boolean {
  return statusOf(error) === 403 && errorCode(error) === 'SUBSCRIPTION_READ_ONLY';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** HTTP status of an API client error, if it has one. */
export function statusOf(error: unknown): number | null {
  return isRecord(error) && typeof error.status === 'number' ? error.status : null;
}

/**
 * The API's error code in capitals, or an empty string: a guard sends it in the body, a contract
 * handler as the typed client's error code (`CASH_SHORT`, `UPLOAD_EXPIRED`…).
 */
export function errorCode(error: unknown): string {
  const body =
    isRecord(error) && isRecord(error.data) && isRecord(error.data.body) ? error.data.body : null;
  const code =
    typeof body?.code === 'string'
      ? body.code
      : isRecord(error) && typeof error.code === 'string'
        ? error.code
        : '';
  return code.toUpperCase();
}

/**
 * Normalises errors from the typed API client. Guard refusals arrive as `{ code, message }`
 * bodies (kept by the client under `data.body`); handler errors carry their own message.
 */
export function toProblem(error: unknown): Problem {
  if (error instanceof TypeError)
    return { status: null, code: 'network', message: NETWORK_MESSAGE };
  if (!isRecord(error)) return { status: null, code: null, message: GENERIC_MESSAGE };
  const status = statusOf(error);
  const body = isRecord(error.data) && isRecord(error.data.body) ? error.data.body : null;
  const code =
    typeof body?.code === 'string' ? body.code : typeof error.code === 'string' ? error.code : null;
  if (status === 429) return { status, code, message: RATE_LIMITED };
  if (status !== null && status >= 500) return { status, code, message: GENERIC_MESSAGE };
  if (status === 403 && code?.toUpperCase() === 'SUBSCRIPTION_READ_ONLY')
    return { status, code, message: READ_ONLY_TEXT };
  const scan = scanRefusal(error);
  if (scan === 'pending') return { status, code, message: SCAN_PENDING_TEXT };
  if (scan === 'quarantined') return { status, code, message: QUARANTINED_TEXT };
  const issues = isRecord(error.data) && Array.isArray(error.data.issues) ? error.data.issues : [];
  const issueText = issues
    .map((issue) => (isRecord(issue) && typeof issue.message === 'string' ? issue.message : null))
    .filter((text): text is string => Boolean(text))
    .join(' ');
  const message =
    (typeof body?.message === 'string' && body.message) ||
    issueText ||
    (typeof error.message === 'string' && error.message) ||
    GENERIC_MESSAGE;
  return { status, code, message };
}

const AUTH_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'That email address and password do not match.',
  INVALID_CODE: 'That code is not right. Enter the current code from your authenticator app.',
  INVALID_BACKUP_CODE: 'That backup code is not right, or it has already been used.',
  INVALID_TWO_FACTOR_COOKIE: 'Your sign-in has timed out. Start again.',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: 'Too many wrong codes. Start again.',
  ACCOUNT_TEMPORARILY_LOCKED: 'Too many failed attempts. Try again later.',
  INVALID_PASSWORD: 'That password is not right.',
  INVALID_TOKEN: 'This link is not valid or has expired.',
  PASSWORD_TOO_SHORT: 'Use at least 12 characters.',
  PASSWORD_TOO_LONG: 'Use at most 128 characters.',
  SESSION_NOT_FRESH: 'For your security, sign in again to do this.',
  TOTP_ALREADY_ENABLED: 'Two-step sign-in is already set up for your account.',
  // Phone sign-in for caretakers (AD-06): the phone-number plugin's codes and the API's own.
  INVALID_PHONE_NUMBER: 'Enter a valid phone number, for example 024 412 3456.',
  TOO_MANY_CODES:
    'Too many codes have been sent to this number. Wait a few minutes, then ask for a new one.',
  INVALID_OTP: 'That code is not right, or it has expired. Check the SMS, or ask for a new code.',
  OTP_EXPIRED: 'That code has expired. Ask for a new one.',
  OTP_NOT_FOUND: 'That code has expired, or no code was sent. Ask for a new one.',
  TOO_MANY_ATTEMPTS: 'Too many wrong codes. Ask for a new code.',
  // M11 security review (identity): breached passwords, and the step-up code some actions need.
  PASSWORD_COMPROMISED: 'This password has appeared in a data breach; choose another.',
  TOTP_REQUIRED: 'Enter the current 6-digit code from your authenticator app as well.',
  STEP_UP_LOCKED:
    'Too many tries. Wait for the next code from your authenticator app, then try again in a few minutes.',
  STEP_UP_FAILED: 'That code is not right. Enter the current code from your authenticator app.',
};

/** Better Auth client errors (`{ error: { status, code, message } }`) as a Problem. */
/**
 * Signing in with a password (M11 security review): too many attempts locks the account for 15
 * minutes (429 `TOO_MANY_ATTEMPTS`). The same code from phone sign-in means too many wrong codes.
 */
export const SIGN_IN_LOCKED_TEXT = 'Too many attempts; try again in 15 minutes.';

/**
 * A step-up code refused (M11 security review): a wrong code (`step_up_failed`), or too many tries
 * (429 `step_up_locked`). A code works once, so after one is used the next must be waited for.
 */
export function stepUpMessage(error: unknown): string | null {
  const code = errorCode(error);
  return code === 'STEP_UP_LOCKED' || code === 'STEP_UP_FAILED'
    ? (AUTH_MESSAGES[code] ?? null)
    : null;
}

export function passwordSignInProblem(error: unknown): Problem {
  const problem = authProblem(error);
  return problem.status === 429 && problem.code?.toUpperCase() === 'TOO_MANY_ATTEMPTS'
    ? { ...problem, message: SIGN_IN_LOCKED_TEXT }
    : problem;
}

export function authProblem(error: unknown): Problem {
  if (error instanceof TypeError)
    return { status: null, code: 'network', message: NETWORK_MESSAGE };
  if (!isRecord(error)) return { status: null, code: null, message: GENERIC_MESSAGE };
  const status = statusOf(error);
  const code = typeof error.code === 'string' ? error.code : null;
  // A known code says more than its status: "too many codes for this number" is also a 429.
  const known = code ? AUTH_MESSAGES[code] : undefined;
  if (known) return { status, code, message: known };
  if (status === 429) return { status, code, message: RATE_LIMITED };
  if (status === 401 && !code) {
    return { status, code: 'not_authenticated', message: 'Your session has ended. Sign in again.' };
  }
  const own =
    typeof error.message === 'string' && status !== null && status < 500 ? error.message : null;
  return { status, code, message: own || GENERIC_MESSAGE };
}
