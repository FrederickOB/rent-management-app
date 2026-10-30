import { createHash } from 'node:crypto';
import { and, eq, isNull, schema, sql, withCompany, type Database, type Tx } from '@rent/db';
import { AppError } from './errors';
import { isUniqueViolation, sqlStateOf } from './db-errors';

/**
 * Idempotent requests (M2 S8; M4a plan 4.15). A client sends an `Idempotency-Key` with a write.
 *
 * 1. The key is reserved, with a hash of the request, when the request arrives (its own small
 *    transaction), so a duplicate that arrives meanwhile sees it and waits instead of racing.
 * 2. The write's own transaction claims it: it locks the reservation and marks it written, so the
 *    mark commits or rolls back with the write and the write can never happen twice.
 * 3. The response is stored right after; a retry with the same key and body gets it back. The
 *    same key with another body is refused (422).
 */
export interface IdempotencyClaim {
  /** Call first thing in the write's transaction. */
  claim(tx: Tx): Promise<void>;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Canonical JSON (sorted keys), so the same request always hashes the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value;
}

export function requestHash(operation: string, personId: string, input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ operation, personId, input })))
    .digest('hex');
}

export const keyReused = () =>
  new AppError(
    422,
    'idempotency_key_reused',
    'This Idempotency-Key was used for a different request. Use a new key for a new request.',
  );

export const requestInProgress = () =>
  new AppError(
    409,
    'request_in_progress',
    'A request with this Idempotency-Key is still being processed, or its answer was lost. Try again shortly with the same key.',
  );

/** The write had already happened under this key: answer with its stored response. */
class AlreadyWritten extends Error {}

export type Begun<T> =
  | { readonly kind: 'replay'; readonly response: T }
  | { readonly kind: 'run'; readonly claim: IdempotencyClaim };

/** A reservation nobody wrote under for this long, and nobody holds, is taken over. */
const TAKEOVER_MS = 30_000;

/** Stored requests, by company and key. Each person reads only their own (RLS). */
export class IdempotencyStore {
  constructor(
    private readonly database: Database,
    private readonly wait: { readonly attempts: number; readonly ms: number } = {
      attempts: 30,
      ms: 100,
    },
  ) {}

  private ctx(companyId: string, personId: string) {
    return { companyId, personId, actorKind: 'staff' as const };
  }

  private where(companyId: string, key: string) {
    return and(
      eq(schema.idempotentRequest.companyId, companyId),
      eq(schema.idempotentRequest.key, key),
    );
  }

  /**
   * Reserves the key, or answers from an earlier request with it: a replay of its response once
   * stored, a wait while it runs, a takeover when it died before writing.
   */
  async begin<T>(input: {
    readonly companyId: string;
    readonly personId: string;
    readonly key: string;
    readonly operation: string;
    readonly hash: string;
  }): Promise<Begun<T>> {
    const ctx = this.ctx(input.companyId, input.personId);
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await withCompany(this.database, ctx, async (tx) => {
        const inserted = await tx
          .insert(schema.idempotentRequest)
          .values({
            companyId: input.companyId,
            key: input.key,
            operation: input.operation,
            personId: input.personId,
            requestHash: input.hash,
          })
          .onConflictDoNothing()
          .returning({ key: schema.idempotentRequest.key });
        if (inserted.length > 0) return { kind: 'run' as const };
        const [row] = await tx
          .select()
          .from(schema.idempotentRequest)
          .where(this.where(input.companyId, input.key));
        // Someone else's key: refused as reused, without saying whose.
        if (!row || row.requestHash !== input.hash) throw keyReused();
        if (row.response !== null)
          return { kind: 'replay' as const, response: (row.response as { body: T }).body };
        if (row.writtenAt !== null) return { kind: 'wait' as const };
        if (Date.now() - row.createdAt.getTime() < TAKEOVER_MS) return { kind: 'wait' as const };
        // Old and never written: take it over if nobody holds it.
        try {
          await tx.execute(
            sql`select 1 from idempotent_request
                where company_id = ${input.companyId} and key = ${input.key} for update nowait`,
          );
        } catch (error) {
          if (sqlStateOf(error) === '55P03') return { kind: 'wait' as const };
          throw error;
        }
        return { kind: 'run' as const };
      }).catch((error: unknown) => {
        if (sqlStateOf(error) === '55P03') return { kind: 'wait' as const };
        throw error;
      });
      if (outcome.kind === 'replay') return { kind: 'replay', response: outcome.response };
      if (outcome.kind === 'run') return { kind: 'run', claim: this.claimFor(input) };
      if (attempt >= this.wait.attempts) throw requestInProgress();
      await new Promise((resolve) => setTimeout(resolve, this.wait.ms));
    }
  }

  private claimFor(input: { readonly companyId: string; readonly key: string }): IdempotencyClaim {
    return {
      claim: async (tx) => {
        let written: Date | null;
        try {
          const result = await tx.execute<{ written_at: Date | null }>(
            sql`select written_at from idempotent_request
                where company_id = ${input.companyId} and key = ${input.key} for update nowait`,
          );
          if (result.rows.length === 0) throw requestInProgress();
          written = result.rows[0]!.written_at;
        } catch (error) {
          if (sqlStateOf(error) === '55P03') throw requestInProgress();
          throw error;
        }
        if (written) throw new AlreadyWritten();
        await tx
          .update(schema.idempotentRequest)
          .set({ writtenAt: new Date() })
          .where(this.where(input.companyId, input.key));
      },
    };
  }

  /** Stores the response of a request whose write has committed. */
  async complete(
    companyId: string,
    personId: string,
    key: string,
    response: unknown,
  ): Promise<void> {
    await withCompany(this.database, this.ctx(companyId, personId), (tx) =>
      tx
        .update(schema.idempotentRequest)
        .set({ response: { body: response ?? null }, completedAt: new Date() })
        .where(and(this.where(companyId, key), isNull(schema.idempotentRequest.completedAt))),
    );
  }

  /** Frees a key whose request failed before writing anything, so a retry runs again. */
  async release(companyId: string, personId: string, key: string): Promise<void> {
    await withCompany(this.database, this.ctx(companyId, personId), (tx) =>
      tx
        .delete(schema.idempotentRequest)
        .where(and(this.where(companyId, key), isNull(schema.idempotentRequest.writtenAt))),
    );
  }

  /**
   * Runs a write under a key: replays a stored answer, or runs `write` with the claim for its
   * transaction, stores what it answered and returns it.
   */
  async run<T>(
    input: {
      readonly companyId: string;
      readonly personId: string;
      readonly key: string;
      readonly operation: string;
      readonly hash: string;
    },
    write: (claim: IdempotencyClaim) => Promise<T>,
  ): Promise<T> {
    const begun = await this.begin<T>(input);
    if (begun.kind === 'replay') return begun.response;
    let result: T;
    try {
      result = await write(begun.claim);
    } catch (error) {
      if (error instanceof AlreadyWritten || isUniqueViolation(error, 'idempotent_request_pkey')) {
        const again = await this.begin<T>(input);
        if (again.kind === 'replay') return again.response;
        throw requestInProgress();
      }
      if (!(error instanceof AppError && error.code === 'request_in_progress'))
        await this.release(input.companyId, input.personId, input.key).catch(() => undefined);
      throw error;
    }
    await this.complete(input.companyId, input.personId, input.key, result);
    return result;
  }
}
