import { defineJob, type JobDefinition } from '@rent/server/jobs';
import {
  INSPECTION_RENDER_REPORT_JOB,
  MAINTENANCE_AUTO_CLOSE_JOB,
  MAINTENANCE_EMERGENCY_ALERT_JOB,
  MAINTENANCE_SLA_JOB,
  type MaintenanceService,
} from '@rent/server/maintenance';
import {
  MOVEOUT_FINAL_STATEMENT_JOB,
  type MoveInReportService,
  type MoveOutService,
} from '@rent/server/moveout';
import { z } from 'zod';
import { fanOutEvery } from './esign.jobs';
import type { WorkerDeps } from './jobs';

/** Outbox event types the M8 jobs consume (plan 4.13). */
export const MAINTENANCE_EVENT_TYPES = [
  MAINTENANCE_EMERGENCY_ALERT_JOB,
  INSPECTION_RENDER_REPORT_JOB,
  MOVEOUT_FINAL_STATEMENT_JOB,
] as const;

const uuid = z.string().uuid();
const companySlot = z.object({ companyId: uuid, slot: z.string().datetime() }).passthrough();

/**
 * The final statement's PDF, once rendered, recorded on the move-out and sent to the tenant
 * (`documents.rendered`). main.ts passes it to esignJobs' `onRendered`.
 */
export const moveOutOnRendered =
  (moveOuts: Pick<MoveOutService, 'onDocumentRendered'>) =>
  (companyId: string, renderRequestId: string): Promise<boolean> =>
    moveOuts.onDocumentRendered(companyId, renderRequestId);

/**
 * The M8 jobs (plan 4.13). Each is idempotent: an alert once per job, recipient and channel; a
 * warning once per job, target and stage; an auto-close once per job; one move-in report per
 * inspection; one final statement per move-out.
 */
export function maintenanceJobs(
  deps: WorkerDeps & {
    readonly maintenance: MaintenanceService;
    readonly reports: MoveInReportService;
    readonly moveOuts: MoveOutService;
  },
): JobDefinition<never>[] {
  return [
    defineJob({
      name: MAINTENANCE_EMERGENCY_ALERT_JOB,
      // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
      drain: true,
      scope: 'company',
      schema: z.object({ companyId: uuid, jobId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, jobId }) {
        await deps.maintenance.emergencyAlert(companyId, jobId);
      },
    }),
    fanOutEvery(MAINTENANCE_SLA_JOB, '*/15 * * * *', 15, `${MAINTENANCE_SLA_JOB}.company`, deps),
    defineJob({
      name: `${MAINTENANCE_SLA_JOB}.company`,
      scope: 'company',
      schema: companySlot,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const warned = await deps.maintenance.slaCheck(companyId);
        if (warned > 0) ctx.logger.info({ warned }, 'maintenance SLA warnings');
      },
    }),
    fanOutEvery(
      MAINTENANCE_AUTO_CLOSE_JOB,
      '20 4 * * *',
      24 * 60,
      `${MAINTENANCE_AUTO_CLOSE_JOB}.company`,
      deps,
    ),
    defineJob({
      name: `${MAINTENANCE_AUTO_CLOSE_JOB}.company`,
      scope: 'company',
      schema: companySlot,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const closed = await deps.maintenance.autoClose(companyId);
        if (closed > 0) ctx.logger.info({ closed }, 'maintenance jobs closed without a reply');
      },
    }),
    defineJob({
      name: INSPECTION_RENDER_REPORT_JOB,
      // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
      drain: true,
      scope: 'company',
      schema: z
        .object({ companyId: uuid, inspectionId: uuid, requestedBy: uuid.nullable().optional() })
        .passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, inspectionId, requestedBy }) {
        await deps.reports.render(companyId, inspectionId, requestedBy ?? null);
      },
    }),
    defineJob({
      name: MOVEOUT_FINAL_STATEMENT_JOB,
      // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
      drain: true,
      scope: 'company',
      schema: z.object({ companyId: uuid, moveOutId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, moveOutId }) {
        await deps.moveOuts.renderFinalStatement(companyId, moveOutId);
      },
    }),
  ] as JobDefinition<never>[];
}
