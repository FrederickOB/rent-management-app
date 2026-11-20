import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import type { ApiClientOptions } from './client-options';
import { tenantRepairsContract } from './maintenance';
import { meContract } from './me';
import { tenantMessagingContract } from './messaging';
import { tenantMoneyContract } from './payments';
import { tenantAppContract } from './tenancy';

/**
 * The tenant app's own entry (M11 decision 8): only the routes it calls, so its bundle doesn't
 * carry every staff contract. Same keys and routes as the main contract, so a call made through
 * this client is the call web and links make. The types the app reads come with it.
 */
export const tenantContract = {
  me: meContract,
  tenantApp: tenantAppContract,
  tenantMoney: tenantMoneyContract,
  tenantMessaging: tenantMessagingContract,
  tenantRepairs: tenantRepairsContract,
};
export type TenantContract = typeof tenantContract;
export type TenantApiClient = ContractRouterClient<TenantContract>;
export type { ApiClientOptions } from './client-options';

/** Typed client for the tenant app. */
export function createTenantApiClient(options: ApiClientOptions): TenantApiClient {
  const link = new OpenAPILink(tenantContract, {
    url: options.baseUrl,
    headers: async () => (options.headers ? await options.headers() : {}),
    fetch: (request, init) =>
      (options.fetch ?? fetch)(request, { ...init, credentials: options.credentials ?? 'include' }),
  });
  return createORPCClient(link);
}

export type * from './me';
export type * from './maintenance';
export type * from './messaging';
export type * from './payments';
export type * from './tenancy';
