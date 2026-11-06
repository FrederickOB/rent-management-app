import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { METRICS_REFRESH_EVENT, METRICS_ROLLUP_JOB } from '@rent/server/reporting';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './jobs';
import {
  dashboardOnRendered,
  REPORTING_DASHBOARD_EVENT_TYPES,
  reportingDashboardJobs,
} from './reporting-dashboard.jobs';

const companyId = '019a3000-0000-7000-8000-000000000009';

function harness() {
  const rollup = {
    run: vi.fn().mockResolvedValue({
      companyId,
      snapshotDate: '2026-11-06',
      month: '2026-11',
      leases: 12,
      computedAt: new Date('2026-11-06T04:00:00Z'),
    }),
  };
  const jobs = reportingDashboardJobs({ rollup } as unknown as Parameters<
    typeof reportingDashboardJobs
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
  return { byName, rollup, ctx };
}

describe('DA-01 PLATFORM M9 dashboard jobs (plan 4.9; decision 11)', () => {
  it('schedules reporting.metrics-rollup daily at 04:00, fanned out per company, three retries', () => {
    const { byName } = harness();
    const scheduler = byName.get(METRICS_ROLLUP_JOB)!;
    expect(scheduler.cron).toBe('0 4 * * *');
    expect(scheduler.scope).toBe('system');
    const company = byName.get(`${METRICS_ROLLUP_JOB}.company`)!;
    expect(company.scope).toBe('company');
    expect(company.retry.limit).toBe(3);
  });

  it('runs the rollup for the company, on the daily job and on a refresh', async () => {
    const { byName, rollup, ctx } = harness();
    await byName
      .get(`${METRICS_ROLLUP_JOB}.company`)!
      .handle({ companyId, date: '2026-11-06' }, ctx);
    await byName.get(METRICS_REFRESH_EVENT)!.handle({ companyId, requestedBy: companyId }, ctx);
    expect(rollup.run).toHaveBeenCalledTimes(2);
    expect(rollup.run).toHaveBeenNthCalledWith(1, companyId);
    expect(rollup.run).toHaveBeenNthCalledWith(2, companyId);
    // A refresh is an outbox event the relay publishes to its own queue.
    expect(REPORTING_DASHBOARD_EVENT_TYPES).toEqual([METRICS_REFRESH_EVENT]);
  });

  it('never drains: neither queue is filled in bulk', () => {
    const { byName } = harness();
    for (const job of byName.values()) expect(job.drain, job.name).toBeFalsy();
  });

  it('marks a rendered dashboard PDF ready through the documents.rendered hook', async () => {
    const dashboard = { onDocumentRendered: vi.fn().mockResolvedValue(true) };
    const hook = dashboardOnRendered(dashboard);
    await expect(hook(companyId, 'render-1')).resolves.toBe(true);
    expect(dashboard.onDocumentRendered).toHaveBeenCalledWith(companyId, 'render-1');
  });
});
