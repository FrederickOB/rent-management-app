import { phoneNumberClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

function create() {
  // Same origin: /api/auth is proxied to the API, so cookies stay host-only on this origin.
  return createAuthClient({
    baseURL: window.location.origin,
    basePath: '/api/auth',
    // Staff sign in with a password and TOTP; caretakers with a code sent to their phone (AD-06).
    plugins: [twoFactorClient(), phoneNumberClient()],
  });
}

export type AuthClient = ReturnType<typeof create>;

let client: AuthClient | undefined;

/** Better Auth (ADR-011), created on first use because it needs the browser's origin. */
export function authClient(): AuthClient {
  client ??= create();
  return client;
}
