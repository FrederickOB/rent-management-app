import { InMemoryAlert } from '@rent/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob } from '../src/core/jobs/job';
import { JobsService } from '../src/core/jobs/jobs.service';
import { createLogger } from '../src/core/logging/logger';
import { company, startServerTest, type ServerTestContext } from './support';

let ctx: ServerTestContext;
let jobs: JobsService;
const alerts = new InMemoryAlert();
const recorded: { companyId: string; importId: string }[] = [];
let attempts = 0;

const waitFor = async (check: () => boolean, ms = 20_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
};

beforeAll(async () => {
  ctx = await startServerTest();
  jobs = new JobsService(ctx.database, createLogger({ level: 'silent' }), alerts, ctx.db.appUrl, {
    pollingIntervalSeconds: 0.5,
  });
  await jobs.start();
  await jobs.register(
    defineJob({
      name: 'test.gives-up',
      scope: 'company',
      schema: z.object({ companyId: z.string().uuid(), importId: z.string() }).passthrough(),
      retry: { limit: 1, delaySeconds: 1, backoff: false },
      async handle() {
        attempts += 1;
        throw new Error('always fails');
      },
      async onDeadLetter({ companyId, importId }) {
        recorded.push({ companyId, importId });
      },
    }),
  );
  await jobs.register(
    defineJob({
      name: 'test.hook-fails',
      scope: 'company',
      schema: z.object({ companyId: z.string().uuid() }).passthrough(),
      retry: { limit: 0, delaySeconds: 1, backoff: false },
      async handle() {
        throw new Error('always fails');
      },
      async onDeadLetter() {
        throw new Error('the hook fails too');
      },
    }),
  );
  await jobs.watchDeadLetters();
});

afterAll(async () => {
  await jobs?.stop();
  await ctx?.close();
});

describe('PLATFORM jobs dead letters', () => {
  it('records the final failure through the job’s own step, once it has used every retry', async () => {
    const companyId = await company(ctx, 'agency', 'Dead Letter Co');
    await jobs.send('test.gives-up', { companyId, importId: 'import-1' });
    await waitFor(() => recorded.length > 0);
    expect(attempts).toBeGreaterThanOrEqual(2); // the first try and its one retry
    expect(recorded).toEqual([{ companyId, importId: 'import-1' }]);
    expect(
      alerts.raised.some(
        (a) => a.code === 'job.dead_lettered' && a.context?.job === 'test.gives-up',
      ),
    ).toBe(true);
  });

  it('still raises the alert when the failure step itself fails', async () => {
    const companyId = await company(ctx, 'agency', 'Hook Fails Co');
    await jobs.send('test.hook-fails', { companyId });
    await waitFor(() =>
      alerts.raised.some(
        (a) => a.code === 'job.dead_lettered' && a.context?.job === 'test.hook-fails',
      ),
    );
    // The watcher keeps going: a later dead letter is still handled.
    await jobs.send('test.gives-up', { companyId, importId: 'import-2' });
    await waitFor(() => recorded.some((r) => r.importId === 'import-2'));
  });
});
