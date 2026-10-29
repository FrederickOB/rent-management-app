import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../migrate';

/**
 * Integration-test databases (CLAUDE.md section 12: real PostgreSQL, RLS on, never mocked).
 * A run migrates one template database; each test file clones it, so files run in parallel.
 */
export interface TestDatabase {
  readonly name: string;
  /** As the application role (rent_app): RLS applies. */
  readonly appUrl: string;
  /** As the owner role (rent_owner): migrations and setup. */
  readonly ownerUrl: string;
  /** As a superuser: only for tests that must simulate tampering below the application. */
  readonly superuserUrl: string;
  drop(): Promise<void>;
}

const env = (name: string): string => {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set; copy .env.example to .env and start Docker Compose`);
  return value;
};

export function withDatabaseName(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: env('TEST_DATABASE_ADMIN_URL') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

async function createEmpty(client: pg.Client, name: string, template?: string): Promise<void> {
  // CREATE DATABASE ... TEMPLATE fails if another clone is reading the template at that moment.
  await client.query('select pg_advisory_lock(424242)');
  try {
    await client.query(
      `create database ${quote(name)} owner rent_owner${template ? ` template ${quote(template)}` : ''}`,
    );
  } finally {
    await client.query('select pg_advisory_unlock(424242)');
  }
  await client.query(`revoke all on database ${quote(name)} from public`);
  await client.query(`grant connect, temporary on database ${quote(name)} to rent_app`);
}

/** Creates and migrates a template database. `afterMigrate` runs extra setup as the owner. */
export async function createTemplateDatabase(
  label: string,
  afterMigrate?: (ownerUrl: string) => Promise<void>,
): Promise<string> {
  const name = `rent_tpl_${label}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  await admin(async (client) => {
    await client.query(`drop database if exists ${quote(name)} with (force)`);
    await createEmpty(client, name);
  });
  const ownerUrl = withDatabaseName(env('DATABASE_OWNER_URL'), name);
  await runMigrations(ownerUrl);
  if (afterMigrate) await afterMigrate(ownerUrl);
  return name;
}

export async function dropDatabase(name: string): Promise<void> {
  await admin((client) => client.query(`drop database if exists ${quote(name)} with (force)`));
}

export async function cloneTemplateDatabase(template: string): Promise<TestDatabase> {
  const name = `rent_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await admin((client) => createEmpty(client, name, template));
  return {
    name,
    appUrl: withDatabaseName(env('DATABASE_URL'), name),
    ownerUrl: withDatabaseName(env('DATABASE_OWNER_URL'), name),
    superuserUrl: withDatabaseName(env('TEST_DATABASE_ADMIN_URL'), name),
    drop: () => dropDatabase(name),
  };
}

/** Runs SQL on a test database with the given connection string (owner or superuser). */
export async function runSql<T extends pg.QueryResultRow = Record<string, unknown>>(
  url: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url, options: '-c TimeZone=UTC' });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

/** Runs one statement as a superuser with triggers off, to simulate tampering below the application. */
export async function runSqlWithoutTriggers<T extends pg.QueryResultRow = Record<string, unknown>>(
  superuserUrl: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: superuserUrl, options: '-c TimeZone=UTC' });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

export * from './fixtures';
