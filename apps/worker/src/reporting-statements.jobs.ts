import { defineJob, type JobDefinition } from '@rent/server/jobs';
import { OWNER_STATEMENTS_JOB, type OwnerStatementsService } from '@rent/server/reporting';
import { z } from 'zod';
import { fanOut, type WorkerDeps } from './jobs';

/**
 * Outbox event types the statements' jobs consume: none of their own. Issuing requests the PDF
 * through `documents.render-pdf`, and the email goes through `messaging.send`, both relayed already.
 */
export const REPORTING_STATEMENTS_EVENT_TYPES = [] as const;

const uuid = z.string().uuid();

/**
 * An issued statement's PDF, once rendered: its document and SHA-256 recorded, and the email to
 * the owner queued (`documents.rendered`). main.ts passes it to esignJobs' `onRendered`.
 */
export const statementsOnRendered =
  (statements: Pick<OwnerStatementsService, 'onDocumentRendered'>) =>
  (companyId: string, renderRequestId: string): Promise<boolean> =>
    statements.onDocumentRendered(companyId, renderRequestId);

/**
 * The owner statements' job (M9 plan 4.9; architecture section 10): `reporting.owner-statements`
 * runs monthly on the 1st at 06:00 Africa/Accra and fans out one company job per company, which
 * drafts last month's statement for every owner with a book. Idempotent per owner and month (one
 * statement row each), five retries.
 */
export function reportingStatementsJobs(
  deps: WorkerDeps & { readonly statements: OwnerStatementsService },
): JobDefinition<never>[] {
  return [
    fanOut(OWNER_STATEMENTS_JOB, '0 6 1 * *', `${OWNER_STATEMENTS_JOB}.company`, deps),
    defineJob({
      name: `${OWNER_STATEMENTS_JOB}.company`,
      scope: 'company',
      schema: z
        .object({ companyId: uuid, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
        .passthrough(),
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const done = await deps.statements.draftLastMonth(companyId);
        ctx.logger.info({ month: done.month, drafted: done.drafted }, 'owner statements drafted');
      },
    }),
  ] as JobDefinition<never>[];
}
