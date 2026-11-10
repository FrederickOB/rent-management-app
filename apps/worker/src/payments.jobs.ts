import { sql, withSystem, type Database } from '@rent/db';
import { addDays, businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import type { PaymentProviders } from '@rent/server/core';
import { defineJob, type JobDefinition } from '@rent/server/jobs';
import {
  PROCESS_WEBHOOK_JOB,
  REFUND_JOB,
  SETTLEMENT_READY_JOB,
  type ProviderPaymentsService,
  type QueueService,
  type ReceiptsService,
  type ReconciliationService,
  type RemindersService,
  type SettlementAccountsService,
  type WebhooksService,
} from '@rent/server/payments';
import { z } from 'zod';
import { fanOut, type WorkerDeps } from './jobs';

export const VERIFY_PENDING_JOB = 'payments.verify-pending';
export const RENT_REMINDERS_JOB = 'billing.rent-reminders';
export const RECONCILE_TRANSACTIONS_JOB = 'payments.reconcile-transactions';
export const RECONCILE_SETTLEMENTS_JOB = 'payments.reconcile-settlements';
/** `payments.issue-receipt` runs on the queue of the event it consumes (plan 4.12). */
export const ISSUE_RECEIPT_JOB = 'payment.posted';

/** The outbox events the M4b jobs consume: one queue per event, as in M4a. */
export const PAYMENTS_EVENT_TYPES = [ISSUE_RECEIPT_JOB, SETTLEMENT_READY_JOB, REFUND_JOB] as const;

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nothing = z.object({}).passthrough();

export interface PaymentsDeps extends WorkerDeps {
  readonly providers: PaymentProviders;
  readonly webhooks: WebhooksService;
  readonly providerPayments: ProviderPaymentsService;
  readonly receipts: ReceiptsService;
  readonly reminders: RemindersService;
  readonly reconciliation: ReconciliationService;
  readonly accounts: SettlementAccountsService;
  readonly queue: QueueService;
}

/** Yesterday in Accra: reconciliation runs after midnight for the day before (plan 4.8). */
const yesterday = (deps: WorkerDeps) =>
  toIsoDate(addDays(businessDateOf(instantFrom(deps.clock.now())), -1));

async function pendingCompanies(database: Database, before: Date): Promise<string[]> {
  const rows = await withSystem(database, {}, (tx) =>
    tx.execute<{ company_id: string }>(
      sql`select company_id from app.companies_with_pending_intents(${before}::timestamptz)`,
    ),
  );
  return rows.rows.map((r) => r.company_id);
}

/**
 * The M4b jobs (plan 4.12; architecture section 10). Each is idempotent: a webhook on its inbox
 * row (provider and event id), a confirmation on its intent (a confirmed intent is final), a
 * receipt delivery on its receipt, a reminder on its invoice and step, a settlement on its
 * provider and settlement id, a refund on its row, and every posting on its key.
 */
export function paymentsJobs(deps: PaymentsDeps): JobDefinition<never>[] {
  return [
    defineJob({
      name: PROCESS_WEBHOOK_JOB,
      // M11 drill: a burst (decision 7's peak) must clear without a 1 s pause after every job.
      drain: true,
      scope: 'system',
      schema: z.object({ inboxId: uuid }).passthrough(),
      // 10 tries, 1 minute rising to an hour, then the dead letter and an alert.
      retry: { limit: 10, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
      async handle({ inboxId }, ctx) {
        const outcome = await deps.webhooks.process(inboxId);
        ctx.logger.info({ outcome }, 'webhook processed');
      },
      async onDeadLetter({ inboxId }, { error }) {
        // M11 decision 9: the row keeps why its last try failed (a code, never a body).
        if (error) await deps.webhooks.failed(inboxId, error);
        else await deps.webhooks.failed(inboxId);
      },
    }),
    defineJob({
      name: VERIFY_PENDING_JOB,
      scope: 'system',
      cron: '*/5 * * * *',
      schema: nothing,
      retry: { limit: 3, delaySeconds: 30, backoff: true },
      async handle(_payload, ctx) {
        const now = deps.clock.now();
        const window = Math.floor(now.getTime() / 300_000);
        for (const companyId of await pendingCompanies(
          deps.database,
          new Date(now.getTime() - 300_000),
        ))
          await ctx.enqueue(
            `${VERIFY_PENDING_JOB}.company`,
            { companyId },
            { singletonKey: `${companyId}:${window}` },
          );
      },
    }),
    defineJob({
      name: `${VERIFY_PENDING_JOB}.company`,
      // M11 drill: a burst (decision 7's peak) must clear without a 1 s pause after every job.
      drain: true,
      scope: 'company',
      schema: z.object({ companyId: uuid }).passthrough(),
      retry: { limit: 3, delaySeconds: 30, backoff: true },
      async handle({ companyId }, ctx) {
        const checked = await deps.providerPayments.verifyPending(companyId);
        if (checked > 0) ctx.logger.info({ checked }, 'pending intents checked');
      },
    }),
    defineJob({
      name: ISSUE_RECEIPT_JOB,
      // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
      drain: true,
      scope: 'company',
      schema: z.object({ companyId: uuid, receiptId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 5, backoff: true },
      async handle({ companyId, receiptId }, ctx) {
        const outcome = await deps.receipts.issue(companyId, receiptId);
        ctx.logger.info({ outcome }, 'receipt delivery');
      },
    }),
    fanOut(RENT_REMINDERS_JOB, '0 8 * * *', `${RENT_REMINDERS_JOB}.company`, deps),
    defineJob({
      name: `${RENT_REMINDERS_JOB}.company`,
      scope: 'company',
      schema: z.object({ companyId: uuid, date: day }).passthrough(),
      retry: { limit: 3, delaySeconds: 60, backoff: true },
      async handle({ companyId, date }, ctx) {
        const sent = await deps.reminders.run(companyId, date);
        if (sent > 0) ctx.logger.info({ sent }, 'rent reminders queued');
      },
    }),
    defineJob({
      name: RECONCILE_TRANSACTIONS_JOB,
      scope: 'system',
      cron: '0 2 * * *',
      schema: z.object({ day: day.optional() }).passthrough(),
      retry: { limit: 5, delaySeconds: 300, backoff: true },
      async handle({ day: given }, ctx) {
        const date = given ?? yesterday(deps);
        for (const provider of deps.providers.names()) {
          const run = await deps.reconciliation.transactions(provider, date);
          ctx.logger.info({ provider, date, ...run }, 'transactions reconciled');
        }
      },
    }),
    defineJob({
      name: RECONCILE_SETTLEMENTS_JOB,
      scope: 'system',
      cron: '30 2 * * *',
      schema: z.object({ day: day.optional() }).passthrough(),
      retry: { limit: 5, delaySeconds: 300, backoff: true },
      async handle({ day: given }, ctx) {
        const date = given ?? yesterday(deps);
        for (const provider of deps.providers.names()) {
          const posted = await deps.reconciliation.settlements(provider, date);
          ctx.logger.info({ provider, date, posted }, 'settlements reconciled');
        }
      },
    }),
    defineJob({
      name: SETTLEMENT_READY_JOB,
      // The seed or bulk work can fill this queue: no pause between jobs (M8 §9).
      drain: true,
      scope: 'company',
      schema: z.object({ companyId: uuid, accountId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId, accountId }, ctx) {
        const { again } = await deps.accounts.ready(companyId, accountId);
        // Not yet 24 hours since approval: run again when it is.
        if (again)
          await ctx.enqueue(
            SETTLEMENT_READY_JOB,
            { companyId, accountId },
            { startAfter: again, singletonKey: `${accountId}:${again.toISOString()}` },
          );
      },
    }),
    defineJob({
      name: REFUND_JOB,
      scope: 'company',
      schema: z.object({ companyId: uuid, refundId: uuid }).passthrough(),
      retry: { limit: 5, delaySeconds: 60, backoff: true },
      async handle({ companyId, refundId }, ctx) {
        const outcome = await deps.queue.refundWithProvider(companyId, refundId);
        ctx.logger.info({ outcome }, 'unmatched refund');
        // Still being made at the provider: asked again in 10 minutes, unless its webhook comes
        // first (P31 posts only once the provider says it is done; M4b review item 2).
        if (outcome === 'pending') {
          const again = new Date(deps.clock.now().getTime() + 10 * 60_000);
          await ctx.enqueue(
            REFUND_JOB,
            { companyId, refundId },
            { startAfter: again, singletonKey: `${refundId}:${again.toISOString()}` },
          );
        }
      },
    }),
  ] as JobDefinition<never>[];
}
