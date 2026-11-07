import { defineJob, type JobDefinition } from '@rent/server/jobs';
import { FEE_CHECK_JOB, FIXED_FEES_JOB, type ManagementFeesService } from '@rent/server/reporting';
import { z } from 'zod';
import { fanOut, type WorkerDeps } from './jobs';

const companyDay = z
  .object({ companyId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .passthrough();

/**
 * The management fee jobs (M9 plan 4.2 and 4.9; architecture section 10), each fanned out per
 * company:
 * - `reporting.fixed-fees` at 23:00 Africa/Accra from the 28th to the 1st. The company job posts on
 *   the company's last day of a month, and again on the 1st for last month, so a time zone ahead of
 *   Accra or a failed run still posts. Keyed `P14:<owner>:<unit>:<month>`; five retries.
 * - `reporting.fee-check` nightly at 03:15: fees equal rate × base per receipt, and the ledger's
 *   fee income equals the fee records; a difference raises the critical `reporting.fee_mismatch`.
 */
export function reportingMoneyJobs(
  deps: WorkerDeps & { readonly fees: ManagementFeesService },
): JobDefinition<never>[] {
  return [
    fanOut(FIXED_FEES_JOB, '0 23 28-31,1 * *', `${FIXED_FEES_JOB}.company`, deps),
    defineJob({
      name: `${FIXED_FEES_JOB}.company`,
      scope: 'company',
      schema: companyDay,
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const done = await deps.fees.runMonthEnd(companyId);
        if (done.posted > 0) ctx.logger.info(done, 'fixed management fees posted');
      },
    }),
    fanOut(FEE_CHECK_JOB, '15 3 * * *', `${FEE_CHECK_JOB}.company`, deps),
    defineJob({
      name: `${FEE_CHECK_JOB}.company`,
      scope: 'company',
      schema: companyDay,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const { mismatches } = await deps.fees.check(companyId, { alert: true });
        if (mismatches.length > 0)
          ctx.logger.warn({ mismatches: mismatches.length }, 'management fee mismatches');
      },
    }),
  ] as JobDefinition<never>[];
}
