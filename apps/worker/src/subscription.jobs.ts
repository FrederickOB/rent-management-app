import { defineJob, type JobDefinition } from '@rent/server/jobs';
import {
  SUBSCRIPTION_DUNNING_JOB,
  SUBSCRIPTION_INVOICE_JOB,
  SUBSCRIPTION_LIFECYCLE_JOB,
  SUBSCRIPTION_SNAPSHOT_JOB,
  type SubscriptionBillingService,
  type SubscriptionLifecycleService,
  type SubscriptionPaymentsService,
  type SubscriptionSubledgerCheck,
} from '@rent/server/subscription';
import { z } from 'zod';
import { fanOut, type WorkerDeps } from './jobs';

/** Outbox event types the subscription's jobs consume: none of their own. */
export const SUBSCRIPTION_EVENT_TYPES = [] as const;

export const SUBSCRIPTION_SUBLEDGER_JOB = 'subscription.subledger-check';
export const SUBSCRIPTION_VERIFY_PENDING_JOB = 'subscription.verify-pending';

const companyDay = z
  .object({ companyId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .passthrough();
const nothing = z.object({}).passthrough();

/** Invoice and receipt PDFs, once rendered: their document and SHA-256 recorded (main.ts). */
export const subscriptionOnRendered =
  (
    billing: Pick<SubscriptionBillingService, 'onDocumentRendered'>,
    payments: Pick<SubscriptionPaymentsService, 'onDocumentRendered'>,
  ) =>
  async (companyId: string, renderRequestId: string): Promise<boolean> =>
    (await billing.onDocumentRendered(companyId, renderRequestId)) ||
    (await payments.onDocumentRendered(companyId, renderRequestId));

/**
 * The subscription's jobs (M10 plan 4.10; architecture section 10). Each fans out one job per
 * company through `app.company_ids()`; the platform company and anything that is not a landlord
 * or agency is skipped by the services.
 * - `subscription.snapshot`: the 1st at 00:30, last month's billable units (D8). Subscriber + month.
 * - `subscription.invoice`: the 1st at 01:00, last month's invoice. Subscriber + month.
 * - `subscription.lifecycle`: daily at 00:15: trials, downgrades, cancellations, trial reminders.
 * - `subscription.dunning`: daily at 09:00: reminders for past-due invoices, then read-only.
 * - `subscription.subledger-check`: nightly at 03:30, 1100 and 2020 against their sub-ledger.
 * - `subscription.verify-pending`: every 10 minutes, platform charges whose webhook never came.
 */
export function subscriptionJobs(
  deps: WorkerDeps & {
    readonly billing: SubscriptionBillingService;
    readonly lifecycle: SubscriptionLifecycleService;
    readonly payments: SubscriptionPaymentsService;
    readonly subledger: SubscriptionSubledgerCheck;
  },
): JobDefinition<never>[] {
  return [
    fanOut(SUBSCRIPTION_SNAPSHOT_JOB, '30 0 1 * *', `${SUBSCRIPTION_SNAPSHOT_JOB}.company`, deps),
    defineJob({
      name: `${SUBSCRIPTION_SNAPSHOT_JOB}.company`,
      scope: 'company',
      schema: companyDay,
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const snapshot = await deps.billing.snapshot(companyId);
        if (snapshot) ctx.logger.info({ month: snapshot.month }, 'billing snapshot taken');
      },
    }),
    fanOut(SUBSCRIPTION_INVOICE_JOB, '0 1 1 * *', `${SUBSCRIPTION_INVOICE_JOB}.company`, deps),
    defineJob({
      name: `${SUBSCRIPTION_INVOICE_JOB}.company`,
      scope: 'company',
      schema: companyDay,
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const invoice = await deps.billing.invoice(companyId);
        if (invoice) ctx.logger.info({ invoiceId: invoice.id }, 'subscription invoice issued');
      },
    }),
    fanOut(SUBSCRIPTION_LIFECYCLE_JOB, '15 0 * * *', `${SUBSCRIPTION_LIFECYCLE_JOB}.company`, deps),
    defineJob({
      name: `${SUBSCRIPTION_LIFECYCLE_JOB}.company`,
      scope: 'company',
      schema: companyDay,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const state = await deps.lifecycle.daily(companyId);
        if (state?.changed)
          ctx.logger.info({ status: state.status }, 'subscription status changed');
      },
    }),
    fanOut(SUBSCRIPTION_DUNNING_JOB, '0 9 * * *', `${SUBSCRIPTION_DUNNING_JOB}.company`, deps),
    defineJob({
      name: `${SUBSCRIPTION_DUNNING_JOB}.company`,
      scope: 'company',
      schema: companyDay,
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId }, ctx) {
        const state = await deps.lifecycle.dunning(companyId);
        if (state?.accessChanged)
          ctx.logger.info({ access: state.access }, 'subscription access changed');
      },
    }),
    defineJob({
      name: SUBSCRIPTION_SUBLEDGER_JOB,
      scope: 'system',
      cron: '30 3 * * *',
      schema: nothing,
      retry: { limit: 3, delaySeconds: 300, backoff: true },
      async handle(_payload, ctx) {
        const result = await deps.subledger.check({ alert: true });
        ctx.logger.info(
          { mismatches: result.mismatches.length },
          'subscription sub-ledger checked',
        );
      },
    }),
    defineJob({
      name: SUBSCRIPTION_VERIFY_PENDING_JOB,
      scope: 'system',
      cron: '*/10 * * * *',
      schema: nothing,
      retry: { limit: 3, delaySeconds: 30, backoff: true },
      async handle(_payload, ctx) {
        const checked = await deps.payments.verifyPending();
        if (checked > 0) ctx.logger.info({ checked }, 'pending subscription charges verified');
      },
    }),
  ] as JobDefinition<never>[];
}
