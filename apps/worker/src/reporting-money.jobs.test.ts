import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { FEE_CHECK_JOB, FIXED_FEES_JOB } from '@rent/server/reporting';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './jobs';
import { reportingMoneyJobs } from './reporting-money.jobs';

const companyId = '019a3000-0000-7000-8000-00000000000a';

function harness() {
  const fees = {
    runMonthEnd: vi.fn().mockResolvedValue({ months: ['2026-10'], posted: 4 }),
    check: vi.fn().mockResolvedValue({ mismatches: [] }),
  };
  const jobs = reportingMoneyJobs({ fees } as unknown as Parameters<typeof reportingMoneyJobs>[0] &
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
  return { byName, fees, ctx };
}

describe('AC-02 PLATFORM M9 management fee jobs (plan 4.2 and 4.9)', () => {
  it('schedules reporting.fixed-fees at 23:00 from the 28th to the 1st and the nightly fee check, fanned out per company', () => {
    const { byName } = harness();
    expect(byName.get(FIXED_FEES_JOB)!.cron).toBe('0 23 28-31,1 * *');
    expect(byName.get(FIXED_FEES_JOB)!.scope).toBe('system');
    expect(byName.get(`${FIXED_FEES_JOB}.company`)!.scope).toBe('company');
    expect(byName.get(`${FIXED_FEES_JOB}.company`)!.retry.limit).toBe(5);
    expect(byName.get(FEE_CHECK_JOB)!.cron).toBe('15 3 * * *');
    expect(byName.get(`${FEE_CHECK_JOB}.company`)!.scope).toBe('company');
  });

  it('runs the month end for the company, and the fee check with its alert', async () => {
    const { byName, fees, ctx } = harness();
    await byName.get(`${FIXED_FEES_JOB}.company`)!.handle({ companyId, date: '2026-10-31' }, ctx);
    expect(fees.runMonthEnd).toHaveBeenCalledWith(companyId);
    await byName.get(`${FEE_CHECK_JOB}.company`)!.handle({ companyId, date: '2026-11-06' }, ctx);
    expect(fees.check).toHaveBeenCalledWith(companyId, { alert: true });
  });
});
