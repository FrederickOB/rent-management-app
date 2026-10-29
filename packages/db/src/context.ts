import { sql } from 'drizzle-orm';
import type pg from 'pg';
import type { Database, Tx } from './client';

export type ActorKind = 'staff' | 'tenant' | 'platform_admin' | 'system' | 'link';

/**
 * Scope inside a company (AD-02): the owners whose properties a person sees, and the properties
 * assigned to them. The transaction then sees only those properties and owners, through a second,
 * restrictive RLS policy (architecture section 11).
 */
export interface ScopeContext {
  readonly ownerIds: readonly string[];
  readonly propertyIds: readonly string[];
}

/** Company context for one transaction (CLAUDE.md section 5, ADR-002). */
export interface CompanyContext {
  readonly companyId: string;
  readonly personId?: string | null;
  readonly actorKind: ActorKind;
  readonly requestId?: string | null;
  /** Null or absent: the whole company. */
  readonly scope?: ScopeContext | null;
}

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ContextError extends Error {
  override readonly name = 'ContextError';
}

function assertUuid(value: string | null | undefined, what: string): void {
  if (value != null && !UUID.test(value)) throw new ContextError(`${what} must be a UUID`);
}

/**
 * Runs `fn` in a transaction whose RLS context is `ctx`. Settings are transaction-local
 * (`set_config(..., true)`), so nothing survives on a pooled connection. This is the only way
 * application code reads or writes company-scoped tables.
 */
export async function withCompany<T>(
  database: Database,
  ctx: CompanyContext,
  fn: (tx: Tx) => Promise<T>,
  options: { isolationLevel?: IsolationLevel } = {},
): Promise<T> {
  if (!ctx.companyId) throw new ContextError('A company id is required');
  assertUuid(ctx.companyId, 'companyId');
  assertUuid(ctx.personId, 'personId');
  const scope = ctx.scope ?? null;
  if (scope) for (const id of [...scope.ownerIds, ...scope.propertyIds]) assertUuid(id, 'scope id');
  return database.db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.company_id', ${ctx.companyId}, true),
      set_config('app.person_id', ${ctx.personId ?? ''}, true),
      set_config('app.actor_kind', ${ctx.actorKind}, true),
      set_config('app.request_id', ${ctx.requestId ?? ''}, true)`);
    if (scope) {
      // Resolved before the property scope is set, so it reads all of the company's ownership.
      const owners = `{${scope.ownerIds.join(',')}}`;
      const properties = `{${scope.propertyIds.join(',')}}`;
      await tx.execute(sql`select
        set_config('app.property_scope',
          app.resolve_property_scope(${owners}::uuid[], ${properties}::uuid[])::text, true),
        set_config('app.owner_scope', ${owners}, true)`);
    }
    return fn(tx);
  }, options);
}

/**
 * A transaction with no company context, for global tables and the narrow system functions of
 * ADR-002 (schedulers, membership lookup at sign-in, company onboarding, the outbox relay).
 * Company-scoped tables return no rows here, because RLS fails closed.
 */
export async function withSystem<T>(
  database: Database,
  purpose: {
    readonly personId?: string | null;
    readonly requestId?: string | null;
    readonly actorKind?: ActorKind;
  },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(purpose.personId, 'personId');
  return database.db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.company_id', '', true),
      set_config('app.person_id', ${purpose.personId ?? ''}, true),
      set_config('app.actor_kind', ${purpose.actorKind ?? 'system'}, true),
      set_config('app.request_id', ${purpose.requestId ?? ''}, true)`);
    return fn(tx);
  });
}

/**
 * A raw client inside one system transaction, for libraries that need a node-postgres client
 * (pg-boss enqueues in the outbox relay). Commits if `fn` resolves, rolls back otherwise.
 */
export async function withSystemClient<T>(
  database: Database,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      "select set_config('app.company_id', '', true), set_config('app.actor_kind', 'system', true)",
    );
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
