import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './jobs';
import { PAID_UNTIL_PROMPT_JOB, RENT_TAX_ALERTS_JOB, taxJobs } from './tax.jobs';

const companyId = '019a3000-0000-7000-8000-000000000002';

function harness() {
  const taxAlerts = { run: vi.fn().mockResolvedValue(2) };
  const advance = { runPaidUntilPrompts: vi.fn().mockResolvedValue(1) };
  const jobs = taxJobs({ taxAlerts, advance } as unknown as Parameters<typeof taxJobs>[0] &
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
  return { byName, taxAlerts, advance, ctx };
}

describe('PLATFORM M5 worker jobs (plan 5.9)', () => {
  it('schedules TX-02’s alerts and AR-06’s prompt daily at 08:00, three retries each', () => {
    const { byName } = harness();
    for (const name of [RENT_TAX_ALERTS_JOB, PAID_UNTIL_PROMPT_JOB]) {
      expect(byName.get(name)!.cron).toBe('0 8 * * *');
      expect(byName.get(`${name}.company`)!.retry.limit).toBe(3);
    }
  });

  it('runs each company job for its day', async () => {
    const { byName, taxAlerts, advance, ctx } = harness();
    const day = { companyId, date: '2026-11-24' };
    await byName.get(`${RENT_TAX_ALERTS_JOB}.company`)!.handle(day, ctx);
    await byName.get(`${PAID_UNTIL_PROMPT_JOB}.company`)!.handle(day, ctx);
    expect(taxAlerts.run).toHaveBeenCalledWith(companyId, '2026-11-24');
    expect(advance.runPaidUntilPrompts).toHaveBeenCalledWith(companyId, '2026-11-24');
  });
});
