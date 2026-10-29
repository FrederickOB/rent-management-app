import { schema, sql, withCompany, withSystem } from '@rent/db';
import { InMemoryAlert } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob } from '../src/core/jobs/job';
import { JobsService } from '../src/core/jobs/jobs.service';
import { OutboxRelay } from '../src/core/jobs/outbox-relay';
import { createLogger } from '../src/core/logging/logger';
import { enqueueOutbox } from '../src/core/outbox';
import { company, startServerTest, type ServerTestContext } from './support';

let ctx: ServerTestContext;
let jobs: JobsService;
const alerts = new InMemoryAlert();
const logger = createLogger({ level: 'silent' });
const seen: { companyId: string; settingCompany: string; visibleCompanies: number }[] = [];
let failures = 0;

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 20_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
};

const queued = async (name: string) =>
  Number(
    (
      await withSystem(ctx.database, {}, (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from pgboss.job where name = ${name}`,
        ),
      )
    ).rows[0]!.n,
  );

beforeAll(async () => {
  ctx = await startServerTest();
  jobs = new JobsService(ctx.database, logger, alerts, ctx.db.appUrl, {
    pollingIntervalSeconds: 0.5,
  });
  await jobs.start();
  await jobs.register(
    defineJob({
      name: 'test.context',
      scope: 'company',
      schema: z.object({ companyId: z.string().uuid() }).passthrough(),
      retry: { limit: 0, delaySeconds: 1, backoff: false },
      async handle({ companyId }, job) {
        await job.withCompany(async (tx) => {
          const setting = await tx.execute<{ c: string }>(
            sql`select current_setting('app.company_id', true) as c`,
          );
          const visible = await tx.select({ id: schema.company.id }).from(schema.company);
          seen.push({
            companyId,
            settingCompany: setting.rows[0]!.c,
            visibleCompanies: visible.length,
          });
        });
      },
    }),
  );
  await jobs.register(
    defineJob({
      name: 'test.always-fails',
      scope: 'company',
      schema: z.object({ companyId: z.string().uuid() }).passthrough(),
      retry: { limit: 1, delaySeconds: 1, backoff: false },
      async handle() {
        failures += 1;
        throw new Error('boom');
      },
    }),
  );
  await jobs.register(
    defineJob({
      name: 'test.relayed',
      scope: 'company',
      schema: z.object({ companyId: z.string().uuid() }).passthrough(),
      retry: { limit: 0, delaySeconds: 1, backoff: false },
      async handle() {},
    }),
    { workers: false },
  );
  await jobs.watchDeadLetters();
});

afterAll(async () => {
  await jobs?.stop();
  await ctx?.close();
});

describe('PLATFORM jobs', () => {
  it('runs a company job under its payload company, with RLS scoped to it', async () => {
    const a = await company(ctx, 'agency', 'Job Co A');
    await company(ctx, 'agency', 'Job Co B');
    await jobs.send('test.context', { companyId: a });
    await waitFor(() => seen.some((s) => s.companyId === a));
    expect(seen.find((s) => s.companyId === a)).toEqual({
      companyId: a,
      settingCompany: a,
      visibleCompanies: 1,
    });
  });

  it('refuses a company job without a company id, and dead-letters it', async () => {
    const before = seen.length;
    await jobs.send('test.context', { notACompany: true });
    await waitFor(() =>
      alerts.raised.some(
        (x) => x.code === 'job.dead_lettered' && x.context?.job === 'test.context',
      ),
    );
    expect(seen.length).toBe(before);
  });

  it('retries a failing job, then dead-letters it and raises an alert', async () => {
    const a = await company(ctx, 'agency', 'Failing Co');
    await jobs.send('test.always-fails', { companyId: a });
    await waitFor(() =>
      alerts.raised.some(
        (x) => x.code === 'job.dead_lettered' && x.context?.job === 'test.always-fails',
      ),
    );
    expect(failures).toBeGreaterThanOrEqual(2); // first try plus one retry
    expect(
      alerts.raised.find((x) => x.context?.job === 'test.always-fails')!.context,
    ).toMatchObject({ companyId: a });
  });

  it('runs a once() effect only once, however often the job replays', async () => {
    const a = await company(ctx, 'agency', 'Once Co');
    let effects = 0;
    const job = {
      withCompany: <R>(fn: (tx: never) => Promise<R>) =>
        withCompany(ctx.database, { companyId: a, actorKind: 'system' }, fn as never),
    };
    const once = async (key: string) =>
      job.withCompany(async (tx: never) => {
        const t = tx as unknown as Parameters<Parameters<typeof withCompany>[2]>[0];
        const inserted = await t
          .insert(schema.processedJob)
          .values({ companyId: a, key, jobName: 'test' })
          .onConflictDoNothing()
          .returning();
        if (inserted.length) effects += 1;
      });
    await once('effect-1');
    await once('effect-1');
    expect(effects).toBe(1);
  });
});

describe('PLATFORM outbox', () => {
  it('never publishes an event whose transaction rolled back', async () => {
    const a = await company(ctx, 'agency', 'Rollback Co');
    await expect(
      withCompany(ctx.database, { companyId: a, actorKind: 'system' }, async (tx) => {
        await enqueueOutbox(tx, {
          companyId: a,
          type: 'test.relayed',
          payload: { n: 0 },
          idempotencyKey: 'rolled-back',
        });
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');
    const relay = new OutboxRelay(ctx.database, jobs, logger, new Set(['test.relayed']));
    expect(await relay.drain()).toBe(0);
    expect(await queued('test.relayed')).toBe(0);
  });

  it('publishes each event exactly once with two relays running at the same time', async () => {
    const a = await company(ctx, 'agency', 'Relay Co');
    await withCompany(ctx.database, { companyId: a, actorKind: 'system' }, async (tx) => {
      for (let i = 0; i < 40; i += 1)
        await enqueueOutbox(tx, {
          companyId: a,
          type: 'test.relayed',
          payload: { n: i },
          idempotencyKey: `e-${i}`,
        });
      // A replayed business action writes its event once.
      await enqueueOutbox(tx, {
        companyId: a,
        type: 'test.relayed',
        payload: { n: 0 },
        idempotencyKey: 'e-0',
      });
    });
    const one = new OutboxRelay(ctx.database, jobs, logger, new Set(['test.relayed']), 7);
    const two = new OutboxRelay(ctx.database, jobs, logger, new Set(['test.relayed']), 7);
    const [x, y] = await Promise.all([one.drain(), two.drain()]);
    expect(x + y).toBe(40);
    expect(await queued('test.relayed')).toBe(40);
    expect(
      await new OutboxRelay(ctx.database, jobs, logger, new Set(['test.relayed'])).drain(),
    ).toBe(0);
  });
});
