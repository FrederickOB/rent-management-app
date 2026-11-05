import type {
  MESSAGE_BODY_MAX as CONTRACT_BODY_MAX,
  MESSAGE_PHOTO_CONTENT_TYPES as CONTRACT_PHOTO_TYPES,
  MESSAGE_PHOTO_MAX_BYTES as CONTRACT_PHOTO_MAX_BYTES,
} from '@rent/contracts';

// The contract's limits on what a tenant may send (packages/contracts/src/messaging.ts), as values
// the app can use. The app imports the contracts for their types only: at run time they come with
// the API client, which the screen tests replace. The checks below fail the typecheck if the
// contract's values ever change without these.

export const MESSAGE_BODY_MAX = 4_000;
export const MESSAGE_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MESSAGE_PHOTO_MAX_BYTES = 10_000_000;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const bodyMaxMatches: Same<typeof MESSAGE_BODY_MAX, typeof CONTRACT_BODY_MAX> = true;
const photoTypesMatch: Same<
  (typeof MESSAGE_PHOTO_CONTENT_TYPES)[number],
  (typeof CONTRACT_PHOTO_TYPES)[number]
> = true;
const photoMaxMatches: Same<typeof MESSAGE_PHOTO_MAX_BYTES, typeof CONTRACT_PHOTO_MAX_BYTES> = true;
export const CONTRACT_LIMITS_MATCH = bodyMaxMatches && photoTypesMatch && photoMaxMatches;
