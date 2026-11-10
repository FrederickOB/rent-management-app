import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createDatabase, type Database } from './client';
import { cloneTemplateDatabase, runSql, type TestDatabase } from './testing';

/**
 * When Postgres ends an idle pooled connection (a restart, a failover, an administrator), the pool
 * reports it and carries on. Without a listener, node-postgres throws the error and the API or
 * worker process dies; CI saw this as an uncaught 57P01 when a test database was dropped.
 */
describe('NFR-AVAIL the database pool survives a connection the server ends', () => {
  let db: TestDatabase;
  let database: Database;
  const seen: Error[] = [];

  beforeAll(async () => {
    db = await cloneTemplateDatabase(inject('templateDatabase'));
    database = createDatabase(db.appUrl, {
      max: 2,
      applicationName: 'pool-error-test',
      onError: (error) => seen.push(error),
    });
  });

  afterAll(async () => {
    await database.close();
    await db.drop();
  });

  const pidOf = async (target: Database): Promise<number> =>
    (await target.pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;

  it('reports an idle connection the server ends, and the next query opens a fresh one', async () => {
    const pid = await pidOf(database);
    await runSql(db.superuserUrl, 'select pg_terminate_backend($1)', [pid]);
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect((seen[0] as Error & { code?: string }).code).toBe('57P01');
    expect(await pidOf(database)).not.toBe(pid);
  });

  it('writes one line with the code by default, never the connection details', async () => {
    const plain = createDatabase(db.appUrl, { max: 1, applicationName: 'pool-error-default' });
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const pid = await pidOf(plain);
      await runSql(db.superuserUrl, 'select pg_terminate_backend($1)', [pid]);
      await vi.waitFor(() =>
        expect(lines.some((line) => line.includes('database connection ended'))).toBe(true),
      );
    } finally {
      write.mockRestore();
      await plain.close();
    }
    const line = lines.find((l) => l.includes('database connection ended'))!;
    expect(JSON.parse(line)).toMatchObject({ level: 'warn', code: '57P01' });
    expect(line).not.toContain(db.name);
    expect(line).not.toContain('rent_app');
  });
});
