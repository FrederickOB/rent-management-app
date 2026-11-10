import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { MIGRATIONS_FOLDER, runMigrations, runMigrationsFrom } from '../migrate';

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
  // M11 review R2 F4: rent_app creates no temporary tables, so it may not (none can shadow a table
  // a check reads).
  await client.query(`grant connect on database ${quote(name)} to rent_app`);
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

/**
 * A fresh database migrated only up to `lastTag` (for a test of what a later migration does to
 * rows that existed before it). Call `migrateRest()` to apply the migrations after it.
 */
export async function createDatabaseMigratedTo(
  label: string,
  lastTag: string,
): Promise<TestDatabase & { migrateRest(): Promise<void> }> {
  const name = `rent_part_${label}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
  await admin((client) => createEmpty(client, name));
  const ownerUrl = withDatabaseName(env('DATABASE_OWNER_URL'), name);
  const folder = mkdtempSync(path.join(tmpdir(), 'rent-migrations-'));
  try {
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = path.join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const last = journal.entries.findIndex((e) => e.tag === lastTag);
    if (last < 0) throw new Error(`No migration ${lastTag}`);
    journal.entries = journal.entries.slice(0, last + 1);
    writeFileSync(journalPath, JSON.stringify(journal));
    await runMigrationsFrom(ownerUrl, folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return {
    name,
    appUrl: withDatabaseName(env('DATABASE_URL'), name),
    ownerUrl,
    superuserUrl: withDatabaseName(env('TEST_DATABASE_ADMIN_URL'), name),
    drop: () => dropDatabase(name),
    migrateRest: () => runMigrations(ownerUrl),
  };
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
