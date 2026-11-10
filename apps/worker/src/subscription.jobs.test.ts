import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { SUBSCRIPTION_INVOICE_JOB, SUBSCRIPTION_SNAPSHOT_JOB } from '@rent/server/subscription';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './jobs';
import {
  SUBSCRIPTION_INVOICE_CRON,
  SUBSCRIPTION_SNAPSHOT_CRON,
  subscriptionJobs,
} from './subscription.jobs';

const companyId = '019a3000-0000-7000-8000-000000000010';

function harness() {
  const billing = {
    snapshotDue: vi.fn().mockResolvedValue([{ id: 's1', month: '2026-10' }]),
    invoiceDue: vi.fn().mockResolvedValue([
      { id: 'i1', number: 'SUB-2026-000001', totalMinor: 15_000 },
      { id: 'i2', number: 'SUB-2026-000002', totalMinor: 15_000 },
    ]),
    snapshot: vi.fn(),
    invoice: vi.fn(),
    onDocumentRendered: vi.fn(),
  };
  const jobs = subscriptionJobs({
    billing,
    lifecycle: {},
    payments: {},
    subledger: {},
  } as unknown as Parameters<typeof subscriptionJobs>[0] & WorkerDeps);
  const byName = new Map(jobs.map((j) => [j.name, j as JobDefinition<unknown>]));
  const ctx: JobContext = {
    jobId: 'job-1',
    logger: createLogger({ level: 'silent' }),
    companyId,
    withCompany: () => Promise.reject(new Error('not used')),
    once: () => Promise.resolve(true),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
  return { byName, billing, ctx };
}

describe('PB-02 and PB-07 the snapshot and invoice jobs catch up (M10 review BE-13)', () => {
  it('run every day, so a month is billed once it has ended in the subscriber’s time zone', () => {
    const { byName } = harness();
    expect(SUBSCRIPTION_SNAPSHOT_CRON).toBe('30 0 * * *');
    expect(SUBSCRIPTION_INVOICE_CRON).toBe('0 1 * * *');
    expect(byName.get(SUBSCRIPTION_SNAPSHOT_JOB)!.cron).toBe(SUBSCRIPTION_SNAPSHOT_CRON);
    expect(byName.get(SUBSCRIPTION_INVOICE_JOB)!.cron).toBe(SUBSCRIPTION_INVOICE_CRON);
    expect(byName.get(`${SUBSCRIPTION_SNAPSHOT_JOB}.company`)!.retry.limit).toBe(5);
    expect(byName.get(`${SUBSCRIPTION_INVOICE_JOB}.company`)!.retry.limit).toBe(5);
  });

  it('bill as of the payload’s date, every month due, never the old one-month path', async () => {
    const { byName, billing, ctx } = harness();
    const day = { companyId, date: '2026-11-01' };
    const snapshotJob = byName.get(`${SUBSCRIPTION_SNAPSHOT_JOB}.company`)!;
    const invoiceJob = byName.get(`${SUBSCRIPTION_INVOICE_JOB}.company`)!;
    await snapshotJob.handle(snapshotJob.schema.parse(day), ctx);
    await invoiceJob.handle(invoiceJob.schema.parse(day), ctx);
    expect(billing.snapshotDue).toHaveBeenCalledWith(companyId, { date: '2026-11-01' });
    expect(billing.invoiceDue).toHaveBeenCalledWith(companyId, { date: '2026-11-01' });
    expect(billing.snapshot).not.toHaveBeenCalled();
    expect(billing.invoice).not.toHaveBeenCalled();
    // A payload without its date is refused, not billed as of some other day.
    expect(() => invoiceJob.schema.parse({ companyId })).toThrow();
  });
});
