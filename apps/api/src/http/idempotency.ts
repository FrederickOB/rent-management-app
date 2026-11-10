import {
  AppError,
  forbidden,
  IDEMPOTENCY_KEY_PATTERN,
  requestHash,
  type IdempotencyClaim,
  type IdempotencyStore,
} from '@rent/server/core';
import type { RequestContext } from './request-context';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Idempotent writes (M2 S8; M4a plan 4.15), in one place: every money write requires an
 * `Idempotency-Key` header, and any other write may send one. A retry with the same key and body
 * gets the first answer back; the same key with another body is refused (422); a retry while the
 * first is still running is told so (409). The claim is taken inside the write's own transaction.
 */
export async function idempotent<T, R = T>(
  store: IdempotencyStore,
  ctx: RequestContext,
  operation: string,
  input: unknown,
  write: (claim: IdempotencyClaim | null) => Promise<T>,
  render?: (written: T) => Promise<R>,
  options: { readonly required: boolean } = { required: true },
): Promise<R> {
  const answer = (written: T) =>
    render ? render(written) : Promise.resolve(written as unknown as R);
  const key = ctx.headers.get(IDEMPOTENCY_HEADER)?.trim();
  if (!key) {
    if (options.required)
      throw new AppError(
        400,
        'idempotency_key_required',
        'Send an Idempotency-Key header with this request, so a retry is never recorded twice',
      );
    return answer(await write(null));
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key))
    throw new AppError(
      400,
      'idempotency_key_invalid',
      'An Idempotency-Key is 8 to 128 letters, digits, dots, colons, dashes or underscores',
    );
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  // Staff, and platform admins in the platform company (the console's keyed writes, M10 BE-20).
  switch (actor.kind) {
    case 'staff':
    case 'platform_admin':
      break;
    default:
      throw forbidden();
  }
  return store.run(
    {
      companyId: actor.companyId,
      personId: actor.personId,
      key,
      operation,
      hash: requestHash(operation, actor.personId, input),
    },
    (claim) => write(claim),
    render,
  );
}
