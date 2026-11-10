import { MESSAGING_INBOUND_JOB } from '@rent/server/core';
import { defineJob, type JobDefinition, type JobsService } from '@rent/server/jobs';
import {
  OPS_RETRY_JOB,
  PRUNE_JOB,
  QUEUE_AGE_JOB,
  type DeadLetterService,
  type OpsPruningService,
  type QueueMonitorService,
} from '@rent/server/ops';
import { PROCESS_WEBHOOK_JOB } from '@rent/server/payments';
import { z } from 'zod';
import type { WorkerDeps } from './jobs';

/**
 * The outbox events the operations consume (M11 decision 9): a platform admin's webhook replay
 * queues the very job the inbox relay queues for the row (`payments.process-webhook` or
 * `messaging.process-inbound`, `{ inboxId }`); a job retry queues `ops.retry-job`. All three are
 * written in the platform company with the ops_action and its audit event.
 */
export const OPS_EVENT_TYPES = [PROCESS_WEBHOOK_JOB, MESSAGING_INBOUND_JOB, OPS_RETRY_JOB] as const;

export interface OpsDeps extends WorkerDeps {
  readonly jobs: Pick<JobsService, 'send'>;
  readonly deadLetters: DeadLetterService;
  readonly queues: QueueMonitorService;
  readonly pruning: OpsPruningService;
}

const uuid = z.string().uuid();
const nothing = z.object({}).passthrough();

/**
 * The operations jobs (M11 plan 4.14). Idempotent: a retry sends its job once per ops action
 * (processed_job, in the same transaction as the send); the queue check alerts at most once a
 * window per queue and level, whatever runs in a minute; pruning deletes only what is past its
 * age. The worker's heartbeat is a timer in the worker (WorkerHeartbeat), not a job.
 */
export function opsJobs(deps: OpsDeps): JobDefinition<never>[] {
  return [
    defineJob({
      name: OPS_RETRY_JOB,
      scope: 'company',
      schema: z.object({ companyId: uuid, deadLetterJobId: uuid, opsActionId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ deadLetterJobId, opsActionId }, ctx) {
        let outcome: 'sent' | 'gone' | 'done_already' = 'done_already';
        await ctx.once(`ops:job_retry:${opsActionId}`, async (tx) => {
          outcome = await deps.deadLetters.requeue(tx, deadLetterJobId, (queue, payload) =>
            deps.jobs.send(queue, payload, { tx }),
          );
        });
        ctx.logger.info({ outcome, deadLetterJobId }, 'dead-lettered job retried');
      },
    }),
    defineJob({
      name: QUEUE_AGE_JOB,
      scope: 'system',
      // Every minute (plan 4.14: keyed by the minute; the alert windows deduplicate).
      cron: '* * * * *',
      schema: nothing,
      retry: { limit: 2, delaySeconds: 15, backoff: false },
      async handle(_payload, ctx) {
        const result = await deps.queues.alertAges();
        if (result.alerted.length > 0)
          ctx.logger.warn({ alerted: result.alerted }, 'queues past their age thresholds');
      },
    }),
    defineJob({
      name: PRUNE_JOB,
      scope: 'system',
      cron: '40 3 * * *',
      schema: nothing,
      retry: { limit: 3, delaySeconds: 300, backoff: true },
      async handle(_payload, ctx) {
        const pruned = await deps.pruning.prune();
        ctx.logger.info(pruned, 'pruned rate limits and rejected webhooks');
      },
    }),
  ] as JobDefinition<never>[];
}
