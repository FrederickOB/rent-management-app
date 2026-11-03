import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './jobs';
import {
  ISSUE_RECEIPT_JOB,
  PAYMENTS_EVENT_TYPES,
  paymentsJobs,
  RECONCILE_SETTLEMENTS_JOB,
  RECONCILE_TRANSACTIONS_JOB,
  RENT_REMINDERS_JOB,
  VERIFY_PENDING_JOB,
  type PaymentsDeps,
} from './payments.jobs';

const companyId = '019a3000-0000-7000-8000-000000000002';
const accountId = '019a3000-0000-7000-8000-00000000bbbb';

function harness(again: Date | null = null) {
  const deps = {
    clock: { now: () => new Date('2026-11-03T02:00:00Z') },
    providers: { names: () => ['paystack', 'second'] },
    webhooks: {
      process: vi.fn().mockResolvedValue('posted'),
      failed: vi.fn().mockResolvedValue(undefined),
    },
    providerPayments: { verifyPending: vi.fn().mockResolvedValue(1) },
    receipts: { issue: vi.fn().mockResolvedValue('sent') },
    reminders: { run: vi.fn().mockResolvedValue(2) },
    reconciliation: {
      transactions: vi
        .fn()
        .mockResolvedValue({ listed: 0, matched: 0, processed: 0, exceptions: 0 }),
      settlements: vi.fn().mockResolvedValue(0),
    },
    accounts: { ready: vi.fn().mockResolvedValue({ again }) },
    queue: { refundWithProvider: vi.fn().mockResolvedValue('refunded') },
  };
  const jobs = paymentsJobs(deps as unknown as PaymentsDeps & WorkerDeps);
  const byName = new Map(jobs.map((j) => [j.name, j as JobDefinition<unknown>]));
  const ctx: JobContext = {
    jobId: 'job-1',
    logger: createLogger({ level: 'silent' }),
    companyId,
    withCompany: () => Promise.reject(new Error('not used')),
    once: () => Promise.resolve(true),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
  return { byName, deps, ctx };
}

describe('PLATFORM M4b worker jobs (plan 4.12)', () => {
  it('schedules verify-pending, reminders and the two reconciliations, and consumes the events', () => {
    const { byName } = harness();
    expect(byName.get(VERIFY_PENDING_JOB)!.cron).toBe('*/5 * * * *');
    expect(byName.get(RENT_REMINDERS_JOB)!.cron).toBe('0 8 * * *');
    expect(byName.get(RECONCILE_TRANSACTIONS_JOB)!.cron).toBe('0 2 * * *');
    expect(byName.get(RECONCILE_SETTLEMENTS_JOB)!.cron).toBe('30 2 * * *');
    expect(byName.get('payments.process-webhook')!.retry).toMatchObject({
      limit: 10,
      delaySeconds: 60,
      maxDelaySeconds: 3600,
    });
    for (const type of PAYMENTS_EVENT_TYPES) expect(byName.has(type), type).toBe(true);
    expect(byName.get(ISSUE_RECEIPT_JOB)!.retry.limit).toBe(5);
  });

  it('reconciles yesterday for every provider, and issues each receipt for its company', async () => {
    const { byName, deps, ctx } = harness();
    await byName.get(RECONCILE_TRANSACTIONS_JOB)!.handle({}, ctx);
    expect(deps.reconciliation.transactions).toHaveBeenCalledWith('paystack', '2026-11-02');
    expect(deps.reconciliation.transactions).toHaveBeenCalledWith('second', '2026-11-02');
    await byName.get(ISSUE_RECEIPT_JOB)!.handle({ companyId, receiptId: accountId }, ctx);
    expect(deps.receipts.issue).toHaveBeenCalledWith(companyId, accountId);
  });

  it('runs the settlement-account ready job again when its 24 hours have not passed', async () => {
    const at = new Date('2026-11-04T02:00:00Z');
    const { byName, ctx } = harness(at);
    await byName.get('settlement_account.approved')!.handle({ companyId, accountId }, ctx);
    expect(ctx.enqueue).toHaveBeenCalledWith(
      'settlement_account.approved',
      { companyId, accountId },
      { startAfter: at, singletonKey: `${accountId}:${at.toISOString()}` },
    );
  });

  it('records a webhook that failed every retry as failed, not busy', async () => {
    const { byName, deps } = harness();
    await byName.get('payments.process-webhook')!.onDeadLetter!(
      { inboxId: accountId },
      { logger: createLogger({ level: 'silent' }) },
    );
    expect(deps.webhooks.failed).toHaveBeenCalledWith(accountId);
  });
});
