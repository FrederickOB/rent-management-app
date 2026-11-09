import {
  sql,
  withCompany,
  withSystem,
  type ActorKind,
  type Database,
  type IsolationLevel,
  type Tx,
} from '@rent/db';
import { AppError } from '../core/errors';

/**
 * The platform company's context (M10 decision 1): subscriptions, snapshots, invoices, payments,
 * receipts and discount codes belong to it, and the platform book (P26) is its own. Rent never
 * reaches it (D1).
 */
const cache = new WeakMap<Database, string>();

/** The platform company's id; refused with 503 until `pnpm platform:bootstrap` has made it. */
export async function platformCompanyId(database: Database): Promise<string> {
  const known = cache.get(database);
  if (known) return known;
  const result = await withSystem(database, {}, (tx) =>
    tx.execute<{ id: string | null }>(sql`select app.platform_company_id() as id`),
  );
  const id = result.rows[0]?.id ?? null;
  if (!id)
    throw new AppError(
      503,
      'platform_not_bootstrapped',
      'The platform company does not exist yet. Run pnpm platform:bootstrap.',
    );
  cache.set(database, id);
  return id;
}

/** The same inside any transaction (null when there is no platform company). */
export async function platformCompanyIdIn(tx: Tx): Promise<string | null> {
  const result = await tx.execute<{ id: string | null }>(
    sql`select app.platform_company_id() as id`,
  );
  return result.rows[0]?.id ?? null;
}

export interface PlatformContext {
  /** Who is acting: the person behind a request, for the audit chain; none for a job. */
  readonly personId?: string | null;
  readonly requestId?: string | null;
  /** `platform_admin` for the console; otherwise the platform's system path. */
  readonly actorKind?: Extract<ActorKind, 'system' | 'platform_admin'>;
}

/** A transaction in the platform company's context. */
export async function withPlatform<T>(
  database: Database,
  ctx: PlatformContext,
  fn: (tx: Tx, platformId: string) => Promise<T>,
  options: { isolationLevel?: IsolationLevel; accessMode?: 'read only' | 'read write' } = {},
): Promise<T> {
  const platformId = await platformCompanyId(database);
  return withCompany(
    database,
    {
      companyId: platformId,
      personId: ctx.personId ?? null,
      requestId: ctx.requestId ?? null,
      actorKind: ctx.actorKind ?? 'system',
    },
    (tx) => fn(tx, platformId),
    options,
  );
}

/** The platform book (made with the platform company; migration 0058 for an existing one). */
export async function platformBookId(tx: Tx, platformId: string): Promise<string> {
  const result = await tx.execute<{ id: string }>(
    sql`select id from book where company_id = ${platformId}::uuid and kind = 'platform'`,
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('The platform company has no platform book');
  return id;
}

/** One transaction at a time changes a subscriber's subscription (payments, jobs, requests). */
export async function lockSubscription(tx: Tx, subscriberCompanyId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`subscription:${subscriberCompanyId}`}, 23))`,
  );
}
