import { expoClient } from '@better-auth/expo/client';
import { phoneNumberClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { API_URL, APP_SCHEME } from './config';

/**
 * Better Auth client (ADR-011). On iOS and Android the session token lives in SecureStore and
 * is sent as a cookie header; on the web build the browser keeps it as an httpOnly cookie.
 *
 * The Expo plugin keeps only cookies whose names start with `cookiePrefix`, after it strips a
 * `__Host-` or `__Secure-` prefix. The API names them `rent.*` in development and e2e, and
 * `__Host-rent.*` in production (packages/server/src/identity/auth.ts), so `rent` covers both.
 * The plugin's default, `better-auth`, matched neither, so a phone never kept its session (M11).
 */
export const authClient = createAuthClient({
  baseURL: `${API_URL}/api/auth`,
  fetchOptions: { credentials: 'include' },
  plugins: [
    phoneNumberClient(),
    ...(Platform.OS === 'web'
      ? []
      : [
          expoClient({
            scheme: APP_SCHEME,
            storagePrefix: 'rent',
            cookiePrefix: 'rent',
            storage: SecureStore,
          }),
        ]),
  ],
});

/**
 * Cookie header for API calls from native; the web build relies on the browser instead. The Expo
 * plugin's getCookie reads SecureStore, so it answers a promise (M6 review: used as a string, the
 * header was "[object Promise]" and native calls went unauthenticated).
 */
export async function sessionCookieHeader(): Promise<Record<string, string>> {
  if (Platform.OS === 'web') return {};
  const getCookie = (authClient as unknown as { getCookie?: () => string | Promise<string> })
    .getCookie;
  const cookie = await getCookie?.();
  return typeof cookie === 'string' && cookie.length > 0 ? { cookie } : {};
}
