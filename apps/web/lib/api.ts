import { createApiClient, type ApiClient } from '@rent/contracts/client';
import { isRecord } from './errors';
import { keyedClient } from './idempotency';

let client: ApiClient | undefined;

/**
 * The typed API client for browser code (ADR-014). It calls /api/v1 on this origin, which the
 * web server proxies to the API, so the session cookie never leaves the web origin.
 */
export function api(): ApiClient {
  client ??= createApiClient({
    baseUrl: `${window.location.origin}/api/v1`,
    credentials: 'include',
    fetch: followSessionState,
  });
  return client;
}

/**
 * The client for one money write (M4a plan 4.15): every request it sends carries the form
 * submission's Idempotency-Key, so a retry is answered from the first attempt, never recorded
 * again. Take the key from the form's keeper (lib/idempotency) with `sendOnce`.
 */
export function keyedApi(key: string): ApiClient {
  return keyedClient({
    baseUrl: `${window.location.origin}/api/v1`,
    key,
    fetch: followSessionState,
  });
}

/**
 * Sends people to the right screen when their session ends or changes state mid-way, for
 * example after being signed out from another device. The caller still gets the response.
 */
async function followSessionState(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    window.location.assign('/sign-in');
  } else if (response.status === 403) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : null;
    if (code === 'enrolment_required') window.location.assign('/enrol');
    if (code === 'company_required') window.location.assign('/choose-company');
  }
  return response;
}
