import pg from 'pg';

/**
 * Runs SQL statements on a dedicated connection, for set-up as the owner role (migrations,
 * pg-boss's schema and its grants). Never used for application queries.
 */
export async function runStatements(connectionString: string, statements: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(statements);
  } finally {
    await client.end();
  }
}

export type PoolClient = pg.PoolClient;
