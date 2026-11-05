import { sql, withSystem } from '@rent/db';
import { InMemoryAlert } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob } from '../src/core/jobs/job';
import { JobsService } from '../src/core/jobs/jobs.service';
import { createLogger } from '../src/core/logging/logger';
import { startServerTest, type ServerTestContext } from './support';

/**
 * M8 §9 (Backend): a high-volume queue (`drain`, as `messaging.send` is) clears a backlog without
 * the polling pause after every job, still one job at a time and in queue order, and a failed job
 * is retried alone. The queue is the real pg-boss queue, polled every second as in the worker.
 */
let ctx: ServerTestContext;
let jobs: JobsService;
const alerts = new InMemoryAlert();
const logger = createLogger({ level: 'silent' });

const runs: { queue: string; n: number }[] = [];
let running = 0;
let mostAtOnce = 0;
const failedOnce = new Set<number>();

const payload = z.object({ n: z.number().int() }).passthrough();
const work =
  (queue: string, failFirst?: number) =>
  async ({ n }: { n: number }) => {
    running += 1;
    mostAtOnce = Math.max(mostAtOnce, running);
    try {
      // A send takes a little while: long enough for two at once to show.
      await new Promise((r) => setTimeout(r, 15));
      if (n === failFirst && !failedOnce.has(n)) {
        failedOnce.add(n);
        throw new Error('provider timed out');
      }
      runs.push({ queue, n });
    } finally {
      running -= 1;
    }
  };

const ran = (queue: string) => runs.filter((r) => r.queue === queue).map((r) => r.n);

const waitFor = async (check: () => boolean | Promise<boolean>, ms: number) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

beforeAll(async () => {
  ctx = await startServerTest();
  // Default polling: once a second, as the worker runs.
  jobs = new JobsService(ctx.database, logger, alerts, ctx.db.appUrl);
  await jobs.start();
  await jobs.register(
    defineJob({
      name: 'test.drain',
      scope: 'system',
      schema: payload,
      retry: { limit: 0, delaySeconds: 1, backoff: false },
      drain: true,
      handle: work('test.drain'),
    }),
  );
  await jobs.register(
    defineJob({
      name: 'test.paced',
      scope: 'system',
      schema: payload,
      retry: { limit: 0, delaySeconds: 1, backoff: false },
      handle: work('test.paced'),
    }),
  );
  await jobs.register(
    defineJob({
      name: 'test.drain-retry',
      scope: 'system',
      schema: payload,
      retry: { limit: 1, delaySeconds: 1, backoff: false },
      drain: true,
      handle: work('test.drain-retry', 4),
    }),
  );
  await jobs.watchDeadLetters();
});

afterAll(async () => {
  await jobs?.stop();
  await ctx?.close();
});

describe('PLATFORM and CM-08 a send backlog drains without a pause between jobs (M8)', () => {
  it('clears a backlog of 60 jobs well within 60 seconds, one at a time and in queue order', async () => {
    const n = 60;
    const started = Date.now();
    for (let i = 0; i < n; i += 1) await jobs.send('test.drain', { n: i });
    await waitFor(() => ran('test.drain').length === n, 30_000);
    const seconds = (Date.now() - started) / 1000;
    // One job a second would take a minute; the drain takes a few seconds.
    expect(seconds, `drained ${n} jobs in ${seconds} s`).toBeLessThan(10);
    expect(ran('test.drain')).toEqual([...Array(n).keys()]);
    expect(mostAtOnce).toBe(1);
  });

  it('keeps the one-second pause on a queue without drain', async () => {
    const started = Date.now();
    for (let i = 0; i < 5; i += 1) await jobs.send('test.paced', { n: i });
    await waitFor(() => ran('test.paced').length === 5, 20_000);
    // Four pauses of a second between five jobs.
    expect((Date.now() - started) / 1000).toBeGreaterThanOrEqual(3);
    expect(ran('test.paced')).toEqual([0, 1, 2, 3, 4]);
  });

  it('retries only the job that failed; the jobs around it complete once', async () => {
    const settled = async () =>
      (
        await withSystem(ctx.database, {}, (tx) =>
          tx.execute<{ n: number; state: string; retries: number }>(
            sql`select (data->>'n')::int as n, state::text as state, retry_count as retries
                from pgboss.job where name = 'test.drain-retry' order by 1`,
          ),
        )
      ).rows;
    for (let i = 0; i < 10; i += 1) await jobs.send('test.drain-retry', { n: i });
    await waitFor(
      async () => (await settled()).filter((j) => j.state === 'completed').length === 10,
      20_000,
    );
    expect(await settled()).toEqual(
      [...Array(10).keys()].map((n) => ({ n, state: 'completed', retries: n === 4 ? 1 : 0 })),
    );
    expect(ran('test.drain-retry').sort((a, b) => a - b)).toEqual([...Array(10).keys()]);
    expect(failedOnce).toEqual(new Set([4]));
    expect(alerts.raised.filter((a) => a.code === 'job.dead_lettered')).toEqual([]);
    expect(mostAtOnce).toBe(1);
  });
});
