import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCRUE_PERIODS_JOB,
  BILLING_EVENT_TYPES,
  billingJobs,
  GENERATE_INVOICES_JOB,
  SUBLEDGER_CHECK_JOB,
} from './billing.jobs';
import type { WorkerDeps } from './jobs';

const companyId = '019a3000-0000-7000-8000-000000000002';
const leaseId = '019a3000-0000-7000-8000-00000000aaaa';

function harness() {
  const invoicing = {
    generateAll: vi.fn().mockResolvedValue(2),
    accrueAll: vi.fn().mockResolvedValue(3),
    onLeaseSigned: vi.fn().mockResolvedValue(undefined),
    onLeaseActivated: vi.fn().mockResolvedValue(undefined),
    onLeaseEnded: vi.fn().mockResolvedValue(0),
    onLeaseCancelled: vi.fn().mockResolvedValue(0),
  };
  const subledger = { check: vi.fn().mockResolvedValue({ mismatches: [] }) };
  const jobs = billingJobs({ invoicing, subledger } as unknown as Parameters<
    typeof billingJobs
  >[0] &
    WorkerDeps);
  const byName = new Map(jobs.map((j) => [j.name, j as JobDefinition<unknown>]));
  const ctx: JobContext = {
    jobId: 'job-1',
    logger: createLogger({ level: 'silent' }),
    companyId,
    withCompany: () => Promise.reject(new Error('not used')),
    once: () => Promise.resolve(true),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
  return { byName, invoicing, subledger, ctx };
}

describe('PLATFORM M4a worker jobs (plan 4.20)', () => {
  it('schedules the daily invoice, accrual and sub-ledger runs, and consumes the lease events', () => {
    const { byName } = harness();
    expect(byName.get(GENERATE_INVOICES_JOB)!.cron).toBe('10 0 * * *');
    expect(byName.get(ACCRUE_PERIODS_JOB)!.cron).toBe('20 0 * * *');
    expect(byName.get(SUBLEDGER_CHECK_JOB)!.cron).toBe('0 3 * * *');
    expect(byName.get(`${GENERATE_INVOICES_JOB}.company`)!.retry.limit).toBe(5);
    expect(byName.get(`${ACCRUE_PERIODS_JOB}.company`)!.retry.limit).toBe(5);
    expect(byName.get(`${SUBLEDGER_CHECK_JOB}.company`)!.retry.limit).toBe(3);
    for (const type of BILLING_EVENT_TYPES) expect(byName.has(type), type).toBe(true);
  });

  it('runs each company job for its day, and each lease event for its lease', async () => {
    const { byName, invoicing, subledger, ctx } = harness();
    const day = { companyId, date: '2026-11-01' };
    await byName.get(`${GENERATE_INVOICES_JOB}.company`)!.handle(day, ctx);
    await byName.get(`${ACCRUE_PERIODS_JOB}.company`)!.handle(day, ctx);
    await byName.get(`${SUBLEDGER_CHECK_JOB}.company`)!.handle(day, ctx);
    expect(invoicing.generateAll).toHaveBeenCalledWith(companyId, '2026-11-01');
    expect(invoicing.accrueAll).toHaveBeenCalledWith(companyId, '2026-11-01');
    expect(subledger.check).toHaveBeenCalledWith(companyId);
    const event = byName.get('lease.ended')!;
    await event.handle(
      event.schema.parse({ companyId, leaseId, eventId: 'e1', __job: 'lease.ended' }),
      ctx,
    );
    expect(invoicing.onLeaseEnded).toHaveBeenCalledWith(companyId, leaseId, 'job:job-1');
  });
});
