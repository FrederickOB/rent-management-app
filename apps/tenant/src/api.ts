import { createApiClient } from '@rent/contracts/client';
import { sessionCookieHeader } from './auth-client';
import { API_URL } from './config';

/** Typed API client shared with web and links (ADR-014). */
export const api = createApiClient({
  baseUrl: API_URL,
  credentials: 'include',
  headers: () => sessionCookieHeader(),
});
