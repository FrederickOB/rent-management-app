import { createTenantApiClient } from '@rent/contracts/tenant';
import { sessionCookieHeader } from './auth-client';
import { API_URL } from './config';

/**
 * Typed API client (ADR-014), from the contracts' tenant entry: only the routes the tenant app
 * calls, the same routes web and links use, so the bundle carries no staff contract (M11
 * decision 8).
 */
export const api = createTenantApiClient({
  baseUrl: API_URL,
  credentials: 'include',
  headers: () => sessionCookieHeader(),
});
