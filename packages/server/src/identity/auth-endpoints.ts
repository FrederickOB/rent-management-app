/**
 * The Better Auth endpoints the platform exposes. Everything else (sign-up, phone-number
 * changes, phone-based password reset, disabling two-factor, account deletion) is refused
 * before it reaches Better Auth.
 */
const ALLOWED = new Set([
  '/sign-in/email',
  '/sign-out',
  '/get-session',
  '/list-sessions',
  '/revoke-session',
  '/revoke-other-sessions',
  '/change-password',
  '/request-password-reset',
  '/reset-password',
  '/two-factor/enable',
  '/two-factor/get-totp-uri',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/generate-backup-codes',
  '/phone-number/send-otp',
  '/phone-number/verify',
  '/ok',
  '/error',
]);

/** `pathname` relative to the auth base path, for example `/sign-in/email`. */
export function isAllowedAuthPath(pathname: string): boolean {
  if (ALLOWED.has(pathname)) return true;
  // The reset-password link lands on /reset-password/<token> before redirecting to the web app.
  return /^\/reset-password\/[A-Za-z0-9_-]+$/.test(pathname);
}
