import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { OWNER_STATEMENTS_JOB } from '@rent/server/reporting';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './jobs';
import {
  REPORTING_STATEMENTS_EVENT_TYPES,
  reportingStatementsJobs,
  statementsOnRendered,
} from './reporting-statements.jobs';

const companyId = '019a3000-0000-7000-8000-00000000000a';

function harness() {
  const statements = {
    draftLastMonth: vi.fn().mockResolvedValue({ month: '2026-10', drafted: 3 }),
    onDocumentRendered: vi.fn().mockResolvedValue(true),
  };
  const jobs = reportingStatementsJobs({ statements } as unknown as Parameters<
    typeof reportingStatementsJobs
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
  return { byName, statements, ctx };
}

describe('AC-04 PLATFORM M9 owner statement jobs (plan 4.9; decision 7)', () => {
  it('schedules reporting.owner-statements on the 1st at 06:00, fanned out per company, five retries', () => {
    const { byName } = harness();
    const scheduler = byName.get(OWNER_STATEMENTS_JOB)!;
    expect(scheduler.cron).toBe('0 6 1 * *');
    expect(scheduler.scope).toBe('system');
    const company = byName.get(`${OWNER_STATEMENTS_JOB}.company`)!;
    expect(company.scope).toBe('company');
    expect(company.retry.limit).toBe(5);
  });

  it('drafts last month for the company, and records a rendered PDF through the hook', async () => {
    const { byName, statements, ctx } = harness();
    await byName
      .get(`${OWNER_STATEMENTS_JOB}.company`)!
      .handle({ companyId, date: '2026-11-01' }, ctx);
    expect(statements.draftLastMonth).toHaveBeenCalledWith(companyId);
    expect(await statementsOnRendered(statements)(companyId, 'render-1')).toBe(true);
    expect(statements.onDocumentRendered).toHaveBeenCalledWith(companyId, 'render-1');
    expect(REPORTING_STATEMENTS_EVENT_TYPES).toEqual([]);
  });
});
