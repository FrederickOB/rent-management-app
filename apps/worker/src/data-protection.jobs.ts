import {
  DATA_PROTECTION_EXPORT_JOB,
  RETENTION_REVIEW_JOB,
  type DataProtectionService,
  type RetentionReviewService,
} from '@rent/server/data-protection';
import { defineJob, type JobDefinition } from '@rent/server/jobs';
import { z } from 'zod';
import type { WorkerDeps } from './jobs';

/** Outbox event types the data protection jobs consume: an access request's export. */
export const DATA_PROTECTION_EVENT_TYPES = [DATA_PROTECTION_EXPORT_JOB] as const;

const uuid = z.string().uuid();

/**
 * The data protection jobs (M11 decision 5; plan 4.14). Neither logs a tenant's data: the export
 * logs only that it ran, the review only its counts.
 *
 * - `data-protection.export` (keyed by the request's export): the tenant's archive, stored
 *   write-once. A ready or failed export is left alone, so a retry or a replay changes nothing;
 *   after the last retry the export is marked failed with a code.
 * - `retention.review` (daily at 03:15 Africa/Accra, keyed by the day): records past each
 *   verified retention period, across companies; counts only, nothing deleted. A second run the
 *   same day keeps the first day's row.
 */
export function dataProtectionJobs(
  deps: WorkerDeps & {
    readonly dataProtection: DataProtectionService;
    readonly retention: RetentionReviewService;
  },
): JobDefinition<never>[] {
  return [
    defineJob({
      name: DATA_PROTECTION_EXPORT_JOB,
      scope: 'company',
      schema: z.object({ companyId: uuid, exportId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId, exportId }, ctx) {
        const outcome = await deps.dataProtection.prepareExport(companyId, exportId);
        ctx.logger.info({ exportId, outcome }, 'data protection export');
      },
      async onDeadLetter({ companyId, exportId }) {
        await deps.dataProtection.failExport(companyId, exportId, 'export_failed');
      },
    }),
    defineJob({
      name: RETENTION_REVIEW_JOB,
      scope: 'system',
      cron: '15 3 * * *',
      schema: z.object({}).passthrough(),
      retry: { limit: 3, delaySeconds: 300, backoff: true },
      async handle(_payload, ctx) {
        const done = await deps.retention.run();
        ctx.logger.info(
          {
            checkedOn: done.checkedOn,
            stored: done.stored,
            pastRetention: Object.fromEntries(
              done.categories.map((c) => [c.category, c.pastRetention]),
            ),
          },
          'retention review done',
        );
      },
    }),
  ] as JobDefinition<never>[];
}
