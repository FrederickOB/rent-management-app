import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { contract, type Contract } from './index';

export type ApiClient = ContractRouterClient<Contract>;

export interface ApiClientOptions {
  /** API origin, for example http://localhost:3000. */
  readonly baseUrl: string;
  /** Extra headers per request (the Expo app sends its session cookie this way). */
  readonly headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Browser clients send cookies. */
  readonly credentials?: RequestCredentials;
  readonly fetch?: typeof fetch;
}

/** Typed client shared by web, links and the tenant app. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const link = new OpenAPILink(contract, {
    url: options.baseUrl,
    headers: async () => (options.headers ? await options.headers() : {}),
    fetch: (request, init) =>
      (options.fetch ?? fetch)(request, { ...init, credentials: options.credentials ?? 'include' }),
  });
  return createORPCClient(link);
}
