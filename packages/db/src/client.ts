import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A pool plus its Drizzle instance. One per process and role. */
export interface Database {
  readonly pool: pg.Pool;
  readonly db: Db;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly max?: number;
  readonly applicationName?: string;
}

// Business dates are `date` columns; keep them as 'YYYY-MM-DD' strings, never JS Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
// bigint columns hold counts and minor units within the safe-integer range.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('bigint value outside the safe integer range');
  return n;
});

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'rent',
    // Every session runs in UTC; business dates carry no time (CLAUDE.md section 11).
    options: '-c TimeZone=UTC',
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { pool, db, close: () => pool.end() };
}
