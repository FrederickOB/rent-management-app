import { MESSAGE_SEND_JOB, messageRequestSchema } from '@rent/server/core';
import { defineJob, type JobDefinition } from '@rent/server/jobs';
import type { MessagingService } from '@rent/server/messaging';
import {
  FORMAL_LEASE_REMINDERS_JOB,
  IDENTITY_VERIFY_JOB,
  RENEWAL_REMINDERS_JOB,
  RENT_CONTROL_REMINDERS_JOB,
  STAMPING_REMINDERS_JOB,
  type IdChecksService,
  type LeaseLifecycleService,
  type TenancyRemindersService,
} from '@rent/server/tenancy';
import { z } from 'zod';
import { fanOut, type WorkerDeps } from './jobs';

/** Outbox event types the M3 jobs consume. */
export const TENANCY_EVENT_TYPES = [MESSAGE_SEND_JOB, IDENTITY_VERIFY_JOB] as const;

export const LEASE_TRANSITIONS_JOB = 'tenancy.lease-transitions';

const companyDay = z
  .object({ companyId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .passthrough();
/** What the outbox relay and the job runner add to every event payload. */
const ENVELOPE = ['companyId', 'eventId', '__job'] as const;

/**
 * The M3 jobs (plan 4.17; architecture section 10). Each is idempotent: a message is recorded
 * and sent once, each identity poll runs once, transitions are guarded by the lease's status, and
 * each reminder step is recorded in processed_job when it is sent.
 */
export function tenancyJobs(
  deps: WorkerDeps & {
    readonly messaging: MessagingService;
    readonly idChecks: IdChecksService;
    readonly lifecycle: LeaseLifecycleService;
    readonly reminders: TenancyRemindersService;
  },
): JobDefinition<never>[] {
  const daily = (
    name: string,
    cron: string,
    run: (companyId: string, date: string) => Promise<number>,
    retries: number,
  ) => [
    fanOut(name, cron, `${name}.company`, deps),
    defineJob({
      name: `${name}.company`,
      scope: 'company',
      schema: companyDay,
      retry: { limit: retries, delaySeconds: 60, backoff: true },
      async handle({ companyId, date }, ctx) {
        const changed = await run(companyId, date);
        if (changed > 0) ctx.logger.info({ changed }, `${name} done`);
      },
    }),
  ];
  return [
    defineJob({
      name: MESSAGE_SEND_JOB,
      scope: 'company',
      schema: z.object({ companyId: z.string().uuid() }).passthrough(),
      // Five sends per channel, then the next consented channel (plan 4.17).
      retry: { limit: 12, delaySeconds: 30, backoff: true, maxDelaySeconds: 1_800 },
      async handle(payload) {
        const body = { ...(payload as Record<string, unknown>) };
        for (const key of ENVELOPE) delete body[key];
        await deps.messaging.deliver(payload.companyId, messageRequestSchema.parse(body));
      },
    }),
    defineJob({
      name: IDENTITY_VERIFY_JOB,
      scope: 'company',
      schema: z
        .object({
          companyId: z.string().uuid(),
          checkId: z.string().uuid(),
          attempt: z.number().int().min(0).max(5).nullable(),
        })
        .passthrough(),
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId, checkId, attempt }, ctx) {
        await deps.idChecks.run(companyId, checkId, attempt, (next, at) =>
          ctx.enqueue(
            IDENTITY_VERIFY_JOB,
            { companyId, checkId, attempt: next },
            { singletonKey: `${IDENTITY_VERIFY_JOB}:${checkId}:${next}`, startAfter: at },
          ),
        );
      },
    }),
    ...daily(LEASE_TRANSITIONS_JOB, '5 0 * * *', (c, d) => deps.lifecycle.runTransitions(c, d), 5),
    ...daily(RENEWAL_REMINDERS_JOB, '0 8 * * *', (c, d) => deps.reminders.renewals(c, d), 3),
    ...daily(
      RENT_CONTROL_REMINDERS_JOB,
      '0 8 * * *',
      (c, d) => deps.reminders.rentControl(c, d),
      3,
    ),
    ...daily(STAMPING_REMINDERS_JOB, '0 8 * * *', (c, d) => deps.reminders.stamping(c, d), 3),
    ...daily(
      FORMAL_LEASE_REMINDERS_JOB,
      '0 8 * * 1',
      (c, d) => deps.reminders.formalLeases(c, d),
      3,
    ),
  ] as JobDefinition<never>[];
}
