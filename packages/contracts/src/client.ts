import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import type { ApiClientOptions } from './client-options';
import { contract, type Contract } from './index';

export type ApiClient = ContractRouterClient<Contract>;

export type { ApiClientOptions } from './client-options';

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
