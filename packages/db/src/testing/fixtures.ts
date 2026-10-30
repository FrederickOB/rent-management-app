import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * Raw-SQL fixtures for database tests. They use the application role, as the API does, so RLS
 * and grants apply. `as` opens a transaction with the given company context.
 */
export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, options: '-c TimeZone=UTC' });
  await client.connect();
  return client;
}

export async function inContext<T>(
  client: pg.Client,
  ctx: { companyId?: string; personId?: string; actorKind?: string },
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await client.query(
      "select set_config('app.company_id', $1, true), set_config('app.person_id', $2, true), set_config('app.actor_kind', $3, true)",
      [ctx.companyId ?? '', ctx.personId ?? '', ctx.actorKind ?? 'system'],
    );
    const result = await fn();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export async function createCompany(
  client: pg.Client,
  name: string,
  kind = 'landlord',
): Promise<string> {
  return inContext(client, {}, async () => {
    const { rows } = await client.query<{ id: string }>(
      "select app.create_company(null, $1, $2, $2, 'GH', 'Africa/Accra', $2, '{}'::jsonb) as id",
      [kind, name],
    );
    return rows[0]!.id;
  });
}

export async function createPerson(client: pg.Client, name: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    'insert into person (id, name, email, is_test_contact) values ($1, $2, $3, true)',
    [id, name, `${id}@test.invalid`],
  );
  return id;
}

export async function createMembership(
  client: pg.Client,
  companyId: string,
  personId: string,
  role = 'property_manager',
): Promise<string> {
  return inContext(client, { companyId }, async () => {
    const { rows } = await client.query<{ id: string }>(
      'insert into membership (company_id, person_id, role) values ($1, $2, $3) returning id',
      [companyId, personId, role],
    );
    return rows[0]!.id;
  });
}

/** SQLSTATE of a failed query, or null if it succeeded. Drizzle keeps the driver error as `cause`. */
export async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? 'unknown';
  }
}
