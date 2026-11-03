import type { AdvanceService } from '@rent/server/billing';
import { defineJob, type JobDefinition } from '@rent/server/jobs';
import type { TaxAlertsService } from '@rent/server/tax';
import { z } from 'zod';
import { fanOut, type WorkerDeps } from './jobs';

export const RENT_TAX_ALERTS_JOB = 'tax.rent-tax-alerts';
export const PAID_UNTIL_PROMPT_JOB = 'billing.paid-until-prompt';

const companyDay = z
  .object({ companyId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .passthrough();

/**
 * The M5 jobs (plan 5.9; architecture section 10), both daily at 08:00, fanned out per company:
 * TX-02's rent tax alerts (one per item and alert day: a `rent_tax_alert` row) and AR-06's
 * paid-until prompt (one per lease and paid-until date: a `paid_until_prompt` row). Each is
 * idempotent by those rows, so a rerun or a retry sends nothing twice.
 */
export function taxJobs(
  deps: WorkerDeps & {
    readonly taxAlerts: TaxAlertsService;
    readonly advance: AdvanceService;
  },
): JobDefinition<never>[] {
  const daily = (name: string, run: (companyId: string, date: string) => Promise<number>) => [
    fanOut(name, '0 8 * * *', `${name}.company`, deps),
    defineJob({
      name: `${name}.company`,
      scope: 'company',
      schema: companyDay,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId, date }, ctx) {
        const done = await run(companyId, date);
        if (done > 0) ctx.logger.info({ done }, `${name} done`);
      },
    }),
  ];
  return [
    ...daily(RENT_TAX_ALERTS_JOB, (c, d) => deps.taxAlerts.run(c, d)),
    ...daily(PAID_UNTIL_PROMPT_JOB, (c, d) => deps.advance.runPaidUntilPrompts(c, d)),
  ] as JobDefinition<never>[];
}
