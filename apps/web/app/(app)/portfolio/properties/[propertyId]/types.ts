import type { ApiClient } from '@rent/contracts/client';

/** What this person may do on the property page, from the policy (AD-03); the API checks again. */
export interface PropertyPermissions {
  readonly manage: boolean;
  readonly changeOwner: boolean;
  readonly upload: boolean;
  readonly seePhotos: boolean;
  readonly seePapers: boolean;
}

export type RegisterOptions = Awaited<ReturnType<ApiClient['register']['options']>>;

export type Notice = { readonly tone: 'success' | 'error'; readonly text: string } | null;
