import { oc } from '@orpc/contract';
import { OPS_REASON_MAX, OPS_REASON_MIN, QUEUE_LEVELS } from '@rent/domain/ops';
import { z } from 'zod';

/**
 * Operations for platform admins (M11 decision 9): failed and dead-lettered webhooks with replay,
 * dead-lettered jobs with retry, each queue's oldest job and the worker heartbeat. A replay or
 * retry takes a reason, is audited in the platform's chain and runs the normal idempotent path,
 * so doing it twice changes nothing (`platform.ops.replay`, `platform.ops.redrive`). Errors are
 * shown as codes and short messages only: never a request body, phone, email or token.
 */
const uuid = z.string().uuid();
const iso = z.string().datetime();
const minor = z.number().int();
const reason = z.string().trim().min(OPS_REASON_MIN).max(OPS_REASON_MAX);

export const opsWebhookSchema = z.object({
  id: uuid,
  provider: z.string(),
  eventId: z.string(),
  eventType: z.string().nullable(),
  receivedAt: iso,
  /** `failed`: processing gave up; `dead_lettered`: the job went to the dead-letter queue. */
  status: z.enum(['failed', 'dead_lettered', 'processed', 'pending']),
  lastError: z.string().nullable(),
  replayCount: minor,
  lastReplayedAt: iso.nullable(),
  lastReplayedByName: z.string().nullable(),
});

export const opsJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The company the job was for, when it had one. */
  companyId: uuid.nullable(),
  failedAt: iso.nullable(),
  attempts: minor,
  lastError: z.string().nullable(),
  retriedAt: iso.nullable(),
});

export const opsQueueSchema = z.object({
  name: z.string(),
  queued: minor,
  active: minor,
  /** How long the oldest waiting job has waited; null when none waits. */
  oldestAgeSeconds: minor.nullable(),
  warnAfterSeconds: minor,
  criticalAfterSeconds: minor,
  level: z.enum(QUEUE_LEVELS),
});

export const opsHeartbeatSchema = z.object({
  lastBeatAt: iso.nullable(),
  ageSeconds: minor.nullable(),
  healthy: z.boolean(),
});

export const platformOpsContract = {
  webhooks: oc
    .route({
      method: 'GET',
      path: '/platform/ops/webhooks',
      summary: 'Failed and dead-lettered webhooks, newest first',
    })
    .input(
      z.object({
        status: z.enum(['failed', 'dead_lettered']).optional(),
        provider: z.string().max(40).optional(),
      }),
    )
    .output(z.array(opsWebhookSchema)),
  replayWebhook: oc
    .route({
      method: 'POST',
      path: '/platform/ops/webhooks/{webhookId}/replay',
      summary:
        'Process a stored webhook again through the normal idempotent path, with a reason (audited). Replaying twice changes nothing',
    })
    .input(z.object({ webhookId: uuid, reason }))
    .output(opsWebhookSchema),
  jobs: oc
    .route({
      method: 'GET',
      path: '/platform/ops/jobs',
      summary: 'Dead-lettered jobs, newest first',
    })
    .input(z.object({ name: z.string().max(120).optional() }))
    .output(z.array(opsJobSchema)),
  retryJob: oc
    .route({
      method: 'POST',
      path: '/platform/ops/jobs/{jobId}/retry',
      summary: 'Run a dead-lettered job again, with a reason (audited); the job is idempotent',
    })
    .input(z.object({ jobId: z.string().min(1).max(100), reason }))
    .output(opsJobSchema),
  queues: oc
    .route({
      method: 'GET',
      path: '/platform/ops/queues',
      summary:
        'Each queue’s depth and oldest job, with its thresholds (payments 5 and 15 minutes; others 30 and 120)',
    })
    .output(z.array(opsQueueSchema)),
  heartbeat: oc
    .route({ method: 'GET', path: '/platform/ops/heartbeat', summary: 'The worker’s last beat' })
    .output(opsHeartbeatSchema),
};
