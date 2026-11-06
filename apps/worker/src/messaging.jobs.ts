import { MESSAGING_INBOUND_JOB } from '@rent/server/core';
import { defineJob, type JobDefinition } from '@rent/server/jobs';
import {
  BROADCAST_FANOUT_JOB,
  FETCH_MEDIA_JOB,
  PUSH_RECEIPTS_JOB,
  SLA_CHECK_JOB,
  SYNC_TEMPLATES_JOB,
  type BroadcastsService,
  type InboundService,
  type MessagingOperationsService,
  type TemplatesService,
} from '@rent/server/messaging';
import { z } from 'zod';
import { fanOutEvery } from './esign.jobs';
import type { WorkerDeps } from './jobs';

/** Outbox event types the M6 messaging jobs consume (the send job is tenancy's, from M3). */
export const MESSAGING_EVENT_TYPES = [FETCH_MEDIA_JOB, BROADCAST_FANOUT_JOB] as const;

const uuid = z.string().uuid();
const companySlot = z.object({ companyId: uuid, slot: z.string().datetime() }).passthrough();

/**
 * The M6 messaging jobs (plan 4.13). Each is idempotent: an inbound row is processed once (its
 * message id is fixed by the provider's), a media item is copied once (unique per provider and
 * media id), a broadcast batch queues the messages it names, an overdue alert goes once per
 * conversation and deadline, and a push receipt is recorded once per message.
 */
export function messagingJobs(
  deps: WorkerDeps & {
    readonly inbound: InboundService;
    readonly broadcasts: BroadcastsService;
    readonly operations: MessagingOperationsService;
    readonly templates: TemplatesService;
  },
): JobDefinition<never>[] {
  return [
    defineJob({
      name: MESSAGING_INBOUND_JOB,
      // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
      drain: true,
      scope: 'system',
      schema: z.object({ inboxId: uuid }).passthrough(),
      // 10 tries, 1 minute rising to an hour, then the dead letter and an alert.
      retry: { limit: 10, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
      async handle({ inboxId }, ctx) {
        const outcome = await deps.inbound.process(inboxId);
        ctx.logger.info({ outcome }, 'inbound message processed');
      },
      async onDeadLetter({ inboxId }) {
        await deps.inbound.failed(inboxId);
      },
    }),
    defineJob({
      name: FETCH_MEDIA_JOB,
      scope: 'company',
      schema: z
        .object({
          companyId: uuid,
          messageId: uuid,
          channel: z.string(),
          provider: z.string(),
          mediaId: z.string().min(1).max(300),
          kind: z.string(),
          mimeType: z.string().nullable(),
          filename: z.string().nullable(),
          caption: z.string().nullable(),
          inboxId: uuid,
        })
        .passthrough(),
      retry: { limit: 6, delaySeconds: 30, backoff: true, maxDelaySeconds: 1_800 },
      async handle(payload, ctx) {
        const outcome = await deps.inbound.fetchMedia(payload.companyId, payload);
        ctx.logger.info({ outcome }, 'media copied');
      },
    }),
    defineJob({
      name: BROADCAST_FANOUT_JOB,
      // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
      drain: true,
      scope: 'company',
      schema: z
        .object({ companyId: uuid, broadcastId: uuid, batch: z.number().int().min(0) })
        .passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, broadcastId, batch }, ctx) {
        const queued = await deps.broadcasts.fanout(companyId, broadcastId, batch);
        ctx.logger.info({ batch, queued }, 'broadcast batch queued');
      },
    }),
    fanOutEvery(SLA_CHECK_JOB, '*/5 * * * *', 5, `${SLA_CHECK_JOB}.company`, deps),
    defineJob({
      name: `${SLA_CHECK_JOB}.company`,
      scope: 'company',
      schema: companySlot,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const done = await deps.operations.slaCheck(companyId);
        if (done.alerted + done.repairs > 0) ctx.logger.info(done, 'inbox checked');
      },
    }),
    fanOutEvery(PUSH_RECEIPTS_JOB, '*/15 * * * *', 15, `${PUSH_RECEIPTS_JOB}.company`, deps),
    defineJob({
      name: `${PUSH_RECEIPTS_JOB}.company`,
      scope: 'company',
      schema: companySlot,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const done = await deps.operations.pushReceipts(companyId);
        if (done.delivered + done.failed > 0) ctx.logger.info(done, 'push receipts recorded');
      },
    }),
    defineJob({
      name: SYNC_TEMPLATES_JOB,
      scope: 'system',
      cron: '0 6 * * *',
      schema: z.object({}).passthrough(),
      retry: { limit: 3, delaySeconds: 300, backoff: true },
      async handle(_payload, ctx) {
        const recorded = await deps.templates.sync();
        ctx.logger.info({ recorded }, 'template statuses synced');
      },
    }),
  ] as JobDefinition<never>[];
}
