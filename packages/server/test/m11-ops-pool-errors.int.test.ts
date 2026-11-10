import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createDatabase, type Database } from '@rent/db';
import { runSql } from '@rent/db/testing';
import { InMemoryAlert } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CoreModule } from '../src/core/core.module';
import { defineJob } from '../src/core/jobs/job';
import { JobsService } from '../src/core/jobs/jobs.service';
import { createLogger } from '../src/core/logging/logger';
import { poolErrorLogger } from '../src/core/pool-errors';
import { DATABASE } from '../src/core/tokens';
import { startServerTest, type ServerTestContext } from './support';

/**
 * M11 (coordinator follow-up 5): the api's and the worker's own database pools report a
 * connection Postgres ends through the process's logger, as a warning with the error's code only;
 * pg-boss's separate pool reports through `boss.on('error')`, which JobsService logs. Neither
 * process dies, and the next query or job runs on a fresh connection.
 */
let ctx: ServerTestContext;

/** A logger whose JSON lines are kept, as pino writes them. */
function capturedLogger() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  return { logger: createLogger({ level: 'info', destination }), lines, raw };
}

const terminate = (applicationName: string) =>
  runSql(
    ctx.db.superuserUrl,
    `select pg_terminate_backend(pid) from pg_stat_activity
     where application_name = $1 and datname = current_database() and pid <> pg_backend_pid()`,
    [applicationName],
  );

beforeAll(async () => {
  ctx = await startServerTest();
});

afterAll(async () => {
  await ctx?.close();
});

describe('NFR-AVAIL the api and worker pools log an ended connection and carry on (M11)', () => {
  it('logs a warning with the code only, never connection details, and the next query works', async () => {
    const { logger, lines, raw } = capturedLogger();
    const database = createDatabase(ctx.db.appUrl, {
      max: 1,
      applicationName: 'ops-pool-logger',
      onError: poolErrorLogger(logger),
    });
    try {
      await database.pool.query('select 1');
      await terminate('ops-pool-logger');
      await vi.waitFor(() =>
        expect(lines.some((l) => l.msg === 'database connection ended')).toBe(true),
      );
      const line = lines.find((l) => l.msg === 'database connection ended')!;
      expect(line).toMatchObject({ level: 'warn', errorCode: '57P01' });
      expect(Object.keys(line).sort()).toEqual(['errorCode', 'level', 'msg', 'name', 'time']);
      const text = raw.join('\n');
      expect(text).not.toContain(ctx.db.name);
      expect(text).not.toContain('rent_app');
      expect(text).not.toContain('terminating connection');
      expect((await database.pool.query<{ ok: number }>('select 1 as ok')).rows[0]!.ok).toBe(1);
    } finally {
      await database.close();
    }
  });

  it('is what CoreModule gives the api and the worker: their logger, on the database it makes', async () => {
    const { logger, lines } = capturedLogger();
    @Module({
      imports: [
        CoreModule.forRoot({
          config: { ...ctx.config, DATABASE_URL: ctx.db.appUrl },
          logger,
          applicationName: 'ops-core-pool',
        }),
      ],
    })
    class PoolTestModule {}
    const app = await NestFactory.createApplicationContext(PoolTestModule, { logger: false });
    try {
      const database = app.get<Database>(DATABASE);
      await database.pool.query('select 1');
      await terminate('ops-core-pool');
      await vi.waitFor(() =>
        expect(lines.some((l) => l.msg === 'database connection ended')).toBe(true),
      );
      expect(lines.find((l) => l.msg === 'database connection ended')).toMatchObject({
        level: 'warn',
        errorCode: '57P01',
      });
      expect((await database.pool.query<{ ok: number }>('select 1 as ok')).rows[0]!.ok).toBe(1);
      await database.close();
    } finally {
      await app.close();
    }
  });

  it('pg-boss’s own pool: an ended connection is logged as a pg-boss error, and jobs still run', async () => {
    const { logger, lines } = capturedLogger();
    const jobs = new JobsService(ctx.database, logger, new InMemoryAlert(), ctx.db.appUrl, {
      pollingIntervalSeconds: 0.5,
    });
    const ran: string[] = [];
    await jobs.start();
    try {
      await jobs.register(
        defineJob({
          name: 'test.pool-survives',
          scope: 'system',
          schema: z.object({ n: z.string() }).passthrough(),
          retry: { limit: 3, delaySeconds: 1, backoff: false },
          async handle({ n }) {
            ran.push(n);
          },
        }),
      );
      await jobs.send('test.pool-survives', { n: 'before' });
      await vi.waitFor(() => expect(ran).toContain('before'), { timeout: 20_000 });
      // JobsService connects pg-boss as `rent-jobs` (its own pool, separate from the app's).
      await terminate('rent-jobs');
      await vi.waitFor(() => expect(lines.some((l) => l.msg === 'pg-boss error')).toBe(true), {
        timeout: 20_000,
      });
      await jobs.send('test.pool-survives', { n: 'after' });
      await vi.waitFor(() => expect(ran).toContain('after'), { timeout: 30_000 });
    } finally {
      await jobs.stop();
    }
  });
});
