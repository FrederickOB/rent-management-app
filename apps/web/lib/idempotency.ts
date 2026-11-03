import { createApiClient, type ApiClient } from '@rent/contracts/client';
import { useState } from 'react';
import { errorCode, statusOf, toProblem } from './errors';

// Idempotent money writes (M2 S8; M4a plan 4.15). Every money write sends an Idempotency-Key
// header. The key belongs to one submission of a form: it is made when the form is first sent and
// sent again, unchanged, on every retry, so a retry on a slow connection gets the first answer
// back instead of recording the payment twice. Once the API has answered for certain (recorded,
// or refused and recorded nothing), the next submission gets a new key.

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * A random UUID (version 4). It uses getRandomValues, which browsers offer on every page; their
 * randomUUID works only on https and localhost, and a phone on the office network may be neither.
 */
export function newIdempotencyKey(
  fill: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = fill(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * What an attempt says about the money write:
 * - `recorded`: the API answered with success;
 * - `refused`: the API answered and recorded nothing (a 4xx), so the next attempt is a new
 *   submission, which may carry corrected details;
 * - `unknown`: no answer arrived, or the server failed or was busy with the same key, so the
 *   payment may have been recorded and the retry must reuse the key.
 */
export type AttemptOutcome = 'recorded' | 'refused' | 'unknown';

/**
 * The API refuses a key it has seen with other details (plan 4.15): an earlier attempt from the
 * same form reached it, and may have been recorded.
 */
export function isKeyReused(error: unknown): boolean {
  return statusOf(error) === 422 && errorCode(error) === 'IDEMPOTENCY_KEY_REUSED';
}

/** A request with this key is still running, or its answer was lost (409). */
const isInProgress = (error: unknown): boolean =>
  statusOf(error) === 409 && errorCode(error) === 'REQUEST_IN_PROGRESS';

/** A 409 that names no reason: oRPC's own `CONFLICT`, or no code at all. */
const UNNAMED_CONFLICTS: ReadonlySet<string> = new Set(['', 'CONFLICT']);

export function outcomeOf(error: unknown): Exclude<AttemptOutcome, 'recorded'> {
  const status = statusOf(error);
  // No answer (the connection dropped or timed out) or a server failure: it may have been saved.
  if (status === null || status >= 500 || status === 408) return 'unknown';
  // A 409 is unknown only while the key's request may still be running, or when it names no
  // reason. One that names its reason (CASH_SHORT, APPROVAL_OPEN, PAYMENT_MATCHED…) is the API
  // refusing the write: nothing was recorded.
  if (status === 409)
    return isInProgress(error) || UNNAMED_CONFLICTS.has(errorCode(error)) ? 'unknown' : 'refused';
  // A reused key: an earlier attempt reached the API, so this form's key is kept.
  if (isKeyReused(error)) return 'unknown';
  return 'refused';
}

export interface IdempotencyKeeper {
  /** The key for the submission in hand: made on first use and kept until it is settled. */
  readonly key: () => string;
  /** Ends the submission (recorded or refused), or keeps its key for the retry (unknown). */
  readonly settle: (outcome: AttemptOutcome) => void;
  /** Starts a new submission, for someone who chooses to record something else. */
  readonly reset: () => void;
}

export function idempotencyKeeper(make: () => string = newIdempotencyKey): IdempotencyKeeper {
  let current: string | null = null;
  return {
    key: () => (current ??= make()),
    settle: (outcome) => {
      if (outcome !== 'unknown') current = null;
    },
    reset: () => {
      current = null;
    },
  };
}

/** Sends a money write with the submission's key, and settles the key by the answer. */
export async function sendOnce<T>(
  keeper: IdempotencyKeeper,
  send: (key: string) => Promise<T>,
): Promise<T> {
  const key = keeper.key();
  try {
    const result = await send(key);
    keeper.settle('recorded');
    return result;
  } catch (error) {
    keeper.settle(outcomeOf(error));
    throw error;
  }
}

/**
 * What to tell someone after a failed money write, so they know whether sending it again is
 * safe. The API's words for a reused or busy key are about keys; these are about the money.
 */
export function moneyProblem(error: unknown): string {
  // The key may belong to an attempt still running, or to one that failed: nothing is certain.
  if (isKeyReused(error))
    return 'An earlier attempt from this form may already have been recorded, so this one was not. Check the list before recording it again.';
  if (isInProgress(error))
    return 'It is still being recorded, or its answer was lost on the way. Wait a moment, then send it again: it will not be recorded twice.';
  const { message } = toProblem(error);
  return outcomeOf(error) === 'unknown'
    ? `${message} Sending it again is safe: it will not be recorded twice.`
    : message;
}

/** The typed client for one money write: every request it makes carries the submission's key. */
export function keyedClient(options: {
  readonly baseUrl: string;
  readonly key: string;
  readonly fetch?: typeof fetch;
}): ApiClient {
  return createApiClient({
    baseUrl: options.baseUrl,
    credentials: 'include',
    ...(options.fetch ? { fetch: options.fetch } : {}),
    headers: () => ({ [IDEMPOTENCY_HEADER]: options.key }),
  });
}

/** One keeper for the life of a form. */
export function useIdempotencyKeeper(): IdempotencyKeeper {
  const [keeper] = useState(() => idempotencyKeeper());
  return keeper;
}

/**
 * Keepers by name, for a page with a money form per record (a credit note per invoice line). A
 * form closed after an unanswered attempt and opened again keeps its key while the page is open.
 */
export function keeperSet(
  make: () => string = newIdempotencyKey,
): (name: string) => IdempotencyKeeper {
  const keepers = new Map<string, IdempotencyKeeper>();
  return (name) => {
    let keeper = keepers.get(name);
    if (!keeper) {
      keeper = idempotencyKeeper(make);
      keepers.set(name, keeper);
    }
    return keeper;
  };
}

export function useKeepers(): (name: string) => IdempotencyKeeper {
  const [keepers] = useState(() => keeperSet());
  return keepers;
}
