import { createLogger, MESSAGING_INBOUND_JOB } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { OPS_RETRY_JOB, PRUNE_JOB, QUEUE_AGE_JOB } from '@rent/server/ops';
import { PROCESS_WEBHOOK_JOB } from '@rent/server/payments';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './jobs';
import { messagingJobs } from './messaging.jobs';
import { OPS_EVENT_TYPES, opsJobs, type OpsDeps } from './ops.jobs';
import { paymentsJobs } from './payments.jobs';

const platformId = '019a3000-0000-7000-8000-000000000001';
const deadLetterJobId = '019a3000-0000-7000-8000-00000000dead';
const opsActionId = '019a3000-0000-7000-8000-0000000000ac';
const logger = createLogger({ level: 'silent' });

function harness() {
  const tx = { tx: true } as never;
  const deps = {
    jobs: { send: vi.fn().mockResolvedValue(undefined) },
    deadLetters: {
      // As DeadLetterService.runRetry does: once per ops action, sending in that transaction.
      runRetry: vi.fn(
        async (
          once: (key: string, fn: (tx: never) => Promise<void>) => Promise<boolean>,
          input: { opsActionId: string },
          send: (q: string, p: object, tx: never) => Promise<void>,
        ) => {
          await once(`ops:job_retry:${input.opsActionId}`, (t) =>
            send('billing.accrue.company', { companyId: platformId }, t),
          );
          return 'sent' as const;
        },
      ),
    },
    queues: { alertAges: vi.fn().mockResolvedValue({ checked: 3, alerted: [] }) },
    pruning: { prune: vi.fn().mockResolvedValue({ rateLimits: 4, rejectedWebhooks: 1 }) },
  };
  const byName = new Map(
    opsJobs(deps as unknown as OpsDeps & WorkerDeps).map((j) => [
      j.name,
      j as JobDefinition<unknown>,
    ]),
  );
  const keys: string[] = [];
  const ctx: JobContext = {
    jobId: 'job-1',
    logger,
    companyId: platformId,
    withCompany: () => Promise.reject(new Error('not used')),
    once: async (key, fn) => {
      keys.push(key);
      await fn(tx);
      return true;
    },
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
  return { byName, deps, ctx, keys, tx };
}

describe('NFR-AVAIL the operations jobs (M11 decision 9; plan 4.14)', () => {
  it('consume the replays’ processing jobs and the retries from the outbox', () => {
    expect([...OPS_EVENT_TYPES].sort()).toEqual(
      [PROCESS_WEBHOOK_JOB, MESSAGING_INBOUND_JOB, OPS_RETRY_JOB].sort(),
    );
  });

  it('retries a dead-lettered job once per ops action, sending it in the same transaction', async () => {
    const { byName, deps, ctx, keys, tx } = harness();
    const job = byName.get(OPS_RETRY_JOB)!;
    expect(job.scope).toBe('company');
    await job.handle(
      job.schema.parse({ companyId: platformId, deadLetterJobId, opsActionId }),
      ctx,
    );
    expect(keys).toEqual([`ops:job_retry:${opsActionId}`]);
    expect(deps.deadLetters.runRetry).toHaveBeenCalledWith(
      expect.any(Function),
      { deadLetterJobId, opsActionId },
      expect.any(Function),
    );
    expect(deps.jobs.send).toHaveBeenCalledWith(
      'billing.accrue.company',
      { companyId: platformId },
      { tx },
    );
    expect(
      job.schema.safeParse({ companyId: platformId, deadLetterJobId: 'x', opsActionId }).success,
    ).toBe(false);
  });

  it('checks queue ages every minute and prunes daily', async () => {
    const { byName, deps, ctx } = harness();
    const age = byName.get(QUEUE_AGE_JOB)!;
    expect(age).toMatchObject({ scope: 'system', cron: '* * * * *' });
    await age.handle({}, ctx);
    expect(deps.queues.alertAges).toHaveBeenCalledTimes(1);
    const prune = byName.get(PRUNE_JOB)!;
    expect(prune).toMatchObject({ scope: 'system', cron: '40 3 * * *' });
    await prune.handle({}, ctx);
    expect(deps.pruning.prune).toHaveBeenCalledTimes(1);
  });
});

describe('NFR-AVAIL a dead-lettered webhook records why it failed (M11 decision 9)', () => {
  it('hands the dead letter’s error to the payments and messaging inbox rows', async () => {
    const inboxId = '019a3000-0000-7000-8000-0000000000bb';
    const webhooks = { failed: vi.fn().mockResolvedValue(undefined) };
    const inbound = { failed: vi.fn().mockResolvedValue(undefined) };
    const payments = paymentsJobs({ webhooks } as never).find(
      (j) => j.name === PROCESS_WEBHOOK_JOB,
    )!;
    const messaging = messagingJobs({ inbound } as never).find(
      (j) => j.name === MESSAGING_INBOUND_JOB,
    )!;
    const error = 'ProviderError: provider unavailable (HTTP 503)';
    await (payments as JobDefinition<unknown>).onDeadLetter!({ inboxId }, { logger, error });
    await (messaging as JobDefinition<unknown>).onDeadLetter!({ inboxId }, { logger, error });
    expect(webhooks.failed).toHaveBeenCalledWith(inboxId, error);
    expect(inbound.failed).toHaveBeenCalledWith(inboxId, error);
  });
});

describe('NFR-AVAIL a webhook job’s dead letter hands on when it was queued (M11 review)', () => {
  it('passes the queue time, so a row replayed since is not failed', async () => {
    const inboxId = '019a3000-0000-7000-8000-0000000000cc';
    const webhooks = { failed: vi.fn().mockResolvedValue(undefined) };
    const inbound = { failed: vi.fn().mockResolvedValue(undefined) };
    const payments = paymentsJobs({ webhooks } as never).find(
      (j) => j.name === PROCESS_WEBHOOK_JOB,
    )!;
    const messaging = messagingJobs({ inbound } as never).find(
      (j) => j.name === MESSAGING_INBOUND_JOB,
    )!;
    const createdAt = new Date('2026-11-10T09:00:00Z');
    await (payments as JobDefinition<unknown>).onDeadLetter!(
      { inboxId },
      { logger, error: 'Error: down', createdAt },
    );
    await (messaging as JobDefinition<unknown>).onDeadLetter!(
      { inboxId },
      { logger, error: null, createdAt },
    );
    expect(webhooks.failed).toHaveBeenCalledWith(inboxId, 'Error: down', createdAt);
    expect(inbound.failed).toHaveBeenCalledWith(inboxId, null, createdAt);
  });
});
