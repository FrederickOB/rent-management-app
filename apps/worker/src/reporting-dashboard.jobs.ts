import { defineJob, type JobDefinition } from '@rent/server/jobs';
import {
  METRICS_REFRESH_EVENT,
  METRICS_ROLLUP_JOB,
  type DashboardService,
  type ReportingRollupService,
} from '@rent/server/reporting';
import { z } from 'zod';
import { fanOut, type WorkerDeps } from './jobs';

/** Outbox event types the dashboard's jobs consume: a refresh asks for a rollup. */
export const REPORTING_DASHBOARD_EVENT_TYPES = [METRICS_REFRESH_EVENT] as const;

const uuid = z.string().uuid();

/**
 * The dashboard's PDF export, once rendered, marked ready (`documents.rendered`). main.ts passes it
 * to esignJobs' `onRendered`.
 */
export const dashboardOnRendered =
  (dashboard: Pick<DashboardService, 'onDocumentRendered'>) =>
  (companyId: string, renderRequestId: string): Promise<boolean> =>
    dashboard.onDocumentRendered(companyId, renderRequestId);

/**
 * The dashboard's jobs (M9 plan 4.9; architecture section 10). `reporting.metrics-rollup` runs
 * daily at 04:00 Africa/Accra and fans out one company job per company; a refresh from the
 * dashboard queues the same work for one company through the outbox. Both replace the day's
 * snapshot whole, so a retry or a second run changes nothing (company + date). Neither queue is
 * filled in bulk by the seed or by people, so neither drains.
 */
export function reportingDashboardJobs(
  deps: WorkerDeps & { readonly rollup: ReportingRollupService },
): JobDefinition<never>[] {
  return [
    fanOut(METRICS_ROLLUP_JOB, '0 4 * * *', `${METRICS_ROLLUP_JOB}.company`, deps),
    defineJob({
      name: `${METRICS_ROLLUP_JOB}.company`,
      scope: 'company',
      schema: z
        .object({ companyId: uuid, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
        .passthrough(),
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const done = await deps.rollup.run(companyId);
        ctx.logger.info(
          { leases: done.leases, snapshotDate: done.snapshotDate },
          'metrics rollup done',
        );
      },
    }),
    defineJob({
      name: METRICS_REFRESH_EVENT,
      scope: 'company',
      schema: z.object({ companyId: uuid }).passthrough(),
      retry: { limit: 3, delaySeconds: 30, backoff: true },
      async handle({ companyId }, ctx) {
        const done = await deps.rollup.run(companyId);
        ctx.logger.info(
          { leases: done.leases, snapshotDate: done.snapshotDate },
          'metrics refreshed',
        );
      },
    }),
  ] as JobDefinition<never>[];
}
