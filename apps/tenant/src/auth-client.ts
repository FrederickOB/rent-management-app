import { expoClient } from '@better-auth/expo/client';
import { phoneNumberClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { API_URL, APP_SCHEME } from './config';

/**
 * Better Auth client (ADR-011). On iOS and Android the session token lives in SecureStore and
 * is sent as a cookie header; on the web build the browser keeps it as an httpOnly cookie.
 */
export const authClient = createAuthClient({
  baseURL: `${API_URL}/api/auth`,
  fetchOptions: { credentials: 'include' },
  plugins: [
    phoneNumberClient(),
    ...(Platform.OS === 'web'
      ? []
      : [expoClient({ scheme: APP_SCHEME, storagePrefix: 'rent', storage: SecureStore })]),
  ],
});

/** Cookie header for API calls from native; the web build relies on the browser instead. */
export function sessionCookieHeader(): Record<string, string> {
  if (Platform.OS === 'web') return {};
  const getCookie = (authClient as unknown as { getCookie?: () => string }).getCookie;
  const cookie = getCookie?.();
  return cookie ? { cookie } : {};
}
