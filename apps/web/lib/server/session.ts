import 'server-only';
import type { CompanyProfile, MembershipRow, Me } from '@rent/contracts';
import { createApiClient, type ApiClient } from '@rent/contracts/client';
import { headers } from 'next/headers';
import { cache } from 'react';
import { statusOf } from '../errors';

// Server-side only: server components call the API directly, never through the browser proxy.
const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3700').replace(/\/+$/, '');

/** The API as the person making this request: their cookie header is forwarded as it came. */
async function serverApi(): Promise<ApiClient> {
  const cookie = (await headers()).get('cookie');
  const forwarded: Record<string, string> = cookie ? { cookie } : {};
  return createApiClient({ baseUrl: API_BASE_URL, headers: () => forwarded });
}

/** The signed-in person and what their session may do, or null when nobody is signed in. */
export const getMe = cache(async (): Promise<Me | null> => {
  try {
    return await (await serverApi()).me.get();
  } catch (error) {
    if (statusOf(error) === 401) return null;
    throw error;
  }
});

/** The active company, or null when this session may not see it (for example a platform admin). */
export const getCompany = cache(async (): Promise<CompanyProfile | null> => {
  try {
    return await (await serverApi()).company.get();
  } catch (error) {
    const status = statusOf(error);
    if (status === 401 || status === 403 || status === 404) return null;
    throw error;
  }
});

export type Loaded<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly status: number | null };

/** People in the active company; a refusal is returned, not thrown, so a page can hide the section. */
export async function loadMemberships(): Promise<Loaded<MembershipRow[]>> {
  try {
    return { ok: true, data: await (await serverApi()).memberships.list() };
  } catch (error) {
    const status = statusOf(error);
    if (status === 401 || status === 403 || status === 404) return { ok: false, status };
    throw error;
  }
}
