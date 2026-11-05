import type { InvoicingService, SubledgerCheckService } from '@rent/server/billing';
import { defineJob, type JobDefinition } from '@rent/server/jobs';
import { z } from 'zod';
import { fanOut, type WorkerDeps } from './jobs';

export const GENERATE_INVOICES_JOB = 'billing.generate-invoices';
export const ACCRUE_PERIODS_JOB = 'billing.accrue-periods';
export const SUBLEDGER_CHECK_JOB = 'billing.subledger-check';

/** The lease events billing consumes (plan 4.20, `billing.lease-events`): one queue per event. */
export const BILLING_EVENT_TYPES = [
  'lease.signed',
  'lease.activated',
  'lease.ended',
  'lease.cancelled',
] as const;

const uuid = z.string().uuid();
const companyDay = z
  .object({ companyId: uuid, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .passthrough();
const leaseEvent = z.object({ companyId: uuid, leaseId: uuid }).passthrough();

/**
 * The M4a jobs (plan 4.20; architecture section 10). Each is idempotent: an invoice is keyed on
 * its lease and cycle start, an accrual on its line (P02:<line id>), every posting on its key, and
 * each event is handled once per event id (the relay's singleton key) with effects that find
 * nothing left to do when replayed.
 */
export function billingJobs(
  deps: WorkerDeps & {
    readonly invoicing: InvoicingService;
    readonly subledger: SubledgerCheckService;
  },
): JobDefinition<never>[] {
  const daily = (
    name: string,
    cron: string,
    retries: number,
    run: (companyId: string, date: string) => Promise<number>,
  ) => [
    fanOut(name, cron, `${name}.company`, deps),
    defineJob({
      name: `${name}.company`,
      scope: 'company',
      schema: companyDay,
      retry: { limit: retries, delaySeconds: 60, backoff: true },
      async handle({ companyId, date }, ctx) {
        const done = await run(companyId, date);
        if (done > 0) ctx.logger.info({ done }, `${name} done`);
      },
    }),
  ];
  const onEvent = (
    type: (typeof BILLING_EVENT_TYPES)[number],
    handle: (companyId: string, leaseId: string, requestId: string) => Promise<unknown>,
  ) =>
    defineJob({
      name: type,
      // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
      drain: true,
      scope: 'company',
      schema: leaseEvent,
      retry: { limit: 5, delaySeconds: 30, backoff: true },
      async handle({ companyId, leaseId }, ctx) {
        await handle(companyId, leaseId, `job:${ctx.jobId}`);
      },
    });
  return [
    ...daily(GENERATE_INVOICES_JOB, '10 0 * * *', 5, (c, d) => deps.invoicing.generateAll(c, d)),
    ...daily(ACCRUE_PERIODS_JOB, '20 0 * * *', 5, (c, d) => deps.invoicing.accrueAll(c, d)),
    ...daily(SUBLEDGER_CHECK_JOB, '0 3 * * *', 3, async (c) => {
      const result = await deps.subledger.check(c);
      return result.mismatches.length;
    }),
    onEvent('lease.signed', (c, l, r) => deps.invoicing.onLeaseSigned(c, l, r)),
    onEvent('lease.activated', (c, l, r) => deps.invoicing.onLeaseActivated(c, l, r)),
    onEvent('lease.ended', (c, l, r) => deps.invoicing.onLeaseEnded(c, l, r)),
    onEvent('lease.cancelled', (c, l, r) => deps.invoicing.onLeaseCancelled(c, l, r)),
  ] as JobDefinition<never>[];
}
