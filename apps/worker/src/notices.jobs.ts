import { NOTICE_SIGNING_EVENT } from '@rent/server/esign';
import { defineJob, type JobDefinition } from '@rent/server/jobs';
import { MESSAGE_NOT_SENT_EVENT, NOTICE_DELIVERY_STATUS_JOB } from '@rent/server/messaging';
import {
  NOTICE_ESCALATE_JOB,
  NOTICE_LADDER_JOB,
  type NoticeTrackingService,
} from '@rent/server/notices';
import { z } from 'zod';
import { fanOutEvery } from './esign.jobs';
import type { WorkerDeps } from './jobs';

/**
 * Outbox event types the notices jobs consume (M7 plan 4.12). `notices.issue-delivery` rides on
 * `documents.rendered` (the e-signing jobs' handler calls the notices hook after opening the
 * requests), so it is not listed here.
 */
export const NOTICES_EVENT_TYPES = [
  NOTICE_SIGNING_EVENT,
  NOTICE_DELIVERY_STATUS_JOB,
  NOTICE_ESCALATE_JOB,
  MESSAGE_NOT_SENT_EVENT,
] as const;

/**
 * The notices hook on `documents.rendered` (plan 4.12, `notices.issue-delivery`): after the
 * e-signing engine has opened a notice's requests, the frozen PDF is recorded and the links go
 * out. main.ts passes it to esignJobs' `onRendered`, after the engine's own handling.
 */
export const noticesOnRendered =
  (tracking: Pick<NoticeTrackingService, 'onDocumentRendered'>) =>
  (companyId: string, renderRequestId: string): Promise<boolean> =>
    tracking.onDocumentRendered(companyId, renderRequestId);

const uuid = z.string().uuid();
const companySlot = z.object({ companyId: uuid, slot: z.string().datetime() }).passthrough();

/**
 * The notices jobs (plan 4.12). Each is idempotent: every event lands once by its dedupe key (a
 * first open, a signature, a delivery report per recipient and channel, a ladder step per
 * recipient and step, the escalation per notice), tasks once by theirs, and documents are set once.
 */
export function noticesJobs(
  deps: WorkerDeps & { readonly tracking: NoticeTrackingService },
): JobDefinition<never>[] {
  return [
    defineJob({
      name: NOTICE_SIGNING_EVENT,
      // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
      drain: true,
      scope: 'company',
      schema: z
        .object({
          companyId: uuid,
          kind: z.enum(['opened', 'signed', 'completed']),
          noticeId: uuid,
          signingRequestId: uuid,
          signerId: uuid.optional(),
          at: z.string().datetime(),
          userAgent: z.string().optional(),
          linkId: uuid.optional(),
        })
        .passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, ...event }) {
        await deps.tracking.onSigningEvent(companyId, event);
      },
    }),
    defineJob({
      name: NOTICE_DELIVERY_STATUS_JOB,
      // M11 drill: a burst (decision 7's peak) must clear without a 1 s pause after every job.
      drain: true,
      scope: 'company',
      schema: z
        .object({
          companyId: uuid,
          recipientId: uuid,
          messageId: uuid,
          eventId: uuid,
          status: z.string(),
          channel: z.string().nullable(),
          at: z.string().datetime(),
        })
        .passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, ...report }) {
        await deps.tracking.onDeliveryStatus(companyId, report);
      },
    }),
    defineJob({
      name: MESSAGE_NOT_SENT_EVENT,
      // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
      drain: true,
      scope: 'company',
      schema: z
        .object({
          companyId: uuid,
          messageId: uuid,
          reason: z.string(),
          related: z.object({ type: z.string(), id: z.string() }).nullable().optional(),
        })
        .passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, ...event }) {
        await deps.tracking.onMessageNotSent(companyId, event);
      },
    }),
    defineJob({
      name: NOTICE_ESCALATE_JOB,
      scope: 'company',
      schema: z.object({ companyId: uuid, noticeId: uuid }).passthrough(),
      // A notice still rendering makes the job wait and try again (plan 4.12: 5 tries).
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId, noticeId }) {
        await deps.tracking.escalate(companyId, noticeId);
      },
    }),
    fanOutEvery(NOTICE_LADDER_JOB, '*/15 * * * *', 15, `${NOTICE_LADDER_JOB}.company`, deps),
    defineJob({
      name: `${NOTICE_LADDER_JOB}.company`,
      scope: 'company',
      schema: companySlot,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const ran = await deps.tracking.runLadder(companyId);
        if (ran.fired + ran.skipped > 0) ctx.logger.info(ran, 'notice ladder steps run');
      },
    }),
  ] as JobDefinition<never>[];
}
