import type { PdfRender } from '@rent/server/documents';
import { DOCUMENT_RENDERED_EVENT } from '@rent/server/documents';
import {
  EXPIRE_LINKS_JOB,
  SIGNING_COMPLETED_EVENT,
  SIGNING_DECLINED_EVENT,
  SIGNING_FINALISE_JOB,
  SIGNING_REMINDERS_JOB,
  type EsignService,
} from '@rent/server/esign';
import { defineJob, type JobDefinition } from '@rent/server/jobs';
import type { LeaseLifecycleService } from '@rent/server/tenancy';
import { z } from 'zod';
import { companyIds, type WorkerDeps } from './jobs';

/** Outbox event types the e-signing jobs consume (plan 4.17; architecture section 10). */
export const ESIGN_EVENT_TYPES = [
  DOCUMENT_RENDERED_EVENT,
  SIGNING_FINALISE_JOB,
  SIGNING_COMPLETED_EVENT,
  SIGNING_DECLINED_EVENT,
] as const;

const uuid = z.string().uuid();
const companySlot = z.object({ companyId: uuid, slot: z.string().datetime() }).passthrough();

/**
 * A scheduler for jobs that run more often than daily: one company job per company per slot of
 * `minutes`, so a slot's job runs once however often the schedule fires (ADR-002 system path).
 */
export function fanOutEvery(
  name: string,
  cron: string,
  minutes: number,
  target: string,
  deps: WorkerDeps,
): JobDefinition<Record<string, unknown>> {
  return defineJob({
    name,
    scope: 'system',
    cron,
    schema: z.object({}).passthrough(),
    retry: { limit: 3, delaySeconds: 60, backoff: true },
    async handle(_payload, ctx) {
      const width = minutes * 60_000;
      const slot = new Date(Math.floor(deps.clock.now().getTime() / width) * width).toISOString();
      for (const companyId of await companyIds(deps.database))
        await ctx.enqueue(
          target,
          { companyId, slot },
          { singletonKey: `${target}:${companyId}:${slot}` },
        );
    },
  });
}

/**
 * The e-signing jobs (M3 plan 4.17). Each is idempotent: a request opens once, finalisation
 * leaves a closed request alone, the lease reacts to a request's event once and never to a
 * stale one, each reminder step is recorded in processed_job, and housekeeping only revokes.
 */
export function esignJobs(
  deps: WorkerDeps & {
    readonly esign: EsignService;
    readonly lifecycle: LeaseLifecycleService;
    readonly render: PdfRender;
    /** M6: others waiting on a rendered PDF (the bot's tenant statements, plan 4.5). */
    readonly onRendered?: readonly ((
      companyId: string,
      renderRequestId: string,
    ) => Promise<boolean>)[];
  },
): JobDefinition<never>[] {
  return [
    defineJob({
      name: DOCUMENT_RENDERED_EVENT,
      scope: 'company',
      schema: z.object({ companyId: uuid, renderRequestId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, renderRequestId }, ctx) {
        if (await deps.esign.onDocumentRendered(companyId, renderRequestId))
          ctx.logger.info('signing request opened');
        for (const next of deps.onRendered ?? [])
          if (await next(companyId, renderRequestId)) ctx.logger.info('rendered document sent');
      },
    }),
    defineJob({
      name: SIGNING_FINALISE_JOB,
      scope: 'company',
      schema: z.object({ companyId: uuid, signingRequestId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, signingRequestId }, ctx) {
        const outcome = await deps.esign.finalise(companyId, signingRequestId, deps.render);
        ctx.logger.info({ outcome }, 'signing request finalised');
      },
    }),
    defineJob({
      name: SIGNING_COMPLETED_EVENT,
      scope: 'company',
      schema: z
        .object({
          companyId: uuid,
          signingRequestId: uuid,
          leaseId: uuid,
          completedAt: z.string().datetime(),
          finalDocumentId: uuid,
        })
        .passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, signingRequestId, leaseId, completedAt, finalDocumentId }) {
        await deps.lifecycle.onSigningCompleted(companyId, {
          leaseId,
          signingRequestId,
          completedAt: new Date(completedAt),
          finalDocumentId,
        });
      },
    }),
    defineJob({
      name: SIGNING_DECLINED_EVENT,
      scope: 'company',
      schema: z.object({ companyId: uuid, signingRequestId: uuid, leaseId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, signingRequestId, leaseId }) {
        await deps.lifecycle.onSigningDeclined(companyId, { leaseId, signingRequestId });
      },
    }),
    fanOutEvery(
      SIGNING_REMINDERS_JOB,
      '*/15 * * * *',
      15,
      `${SIGNING_REMINDERS_JOB}.company`,
      deps,
    ),
    defineJob({
      name: `${SIGNING_REMINDERS_JOB}.company`,
      scope: 'company',
      schema: companySlot,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const sent = await deps.esign.remindUnsigned(companyId);
        if (sent > 0) ctx.logger.info({ sent }, 'signing reminders queued');
      },
    }),
    fanOutEvery(EXPIRE_LINKS_JOB, '0 * * * *', 60, `${EXPIRE_LINKS_JOB}.company`, deps),
    defineJob({
      name: `${EXPIRE_LINKS_JOB}.company`,
      scope: 'company',
      schema: companySlot,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const swept = await deps.esign.expireLinksAndCodes(companyId);
        if (swept.expired + swept.closed + swept.unlocked > 0)
          ctx.logger.info(swept, 'links and codes swept');
      },
    }),
  ] as JobDefinition<never>[];
}
