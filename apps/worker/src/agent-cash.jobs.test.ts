import { createLogger } from '@rent/server/core';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { AGENT_CASH_CHECK_JOB } from '@rent/server/ledger';
import { describe, expect, it, vi } from 'vitest';
import { agentCashJobs } from './agent-cash.jobs';
import type { WorkerDeps } from './jobs';

const companyId = '019a3000-0000-7000-8000-00000000000b';

function harness(negative: { ownerId: string; bookId: string; heldMinor: number }[] = []) {
  const agentCash = {
    check: vi.fn().mockResolvedValue({ companyId, books: 2, negative }),
  };
  const jobs = agentCashJobs({ agentCash } as unknown as Parameters<typeof agentCashJobs>[0] &
    WorkerDeps);
  const byName = new Map(jobs.map((j) => [j.name, j as JobDefinition<unknown>]));
  const logger = createLogger({ level: 'silent' });
  const warn = vi.spyOn(logger, 'warn');
  const ctx: JobContext = {
    jobId: 'job-1',
    logger,
    companyId,
    withCompany: () => Promise.reject(new Error('not used')),
    once: () => Promise.resolve(true),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
  return { byName, agentCash, ctx, warn };
}

describe('AC-05 F3 the nightly agent cash check job', () => {
  it('schedules ledger.agent-cash-check nightly at 03:30, fanned out per company with retries', () => {
    const { byName } = harness();
    expect(AGENT_CASH_CHECK_JOB).toBe('ledger.agent-cash-check');
    expect(byName.get(AGENT_CASH_CHECK_JOB)!.cron).toBe('30 3 * * *');
    expect(byName.get(AGENT_CASH_CHECK_JOB)!.scope).toBe('system');
    expect(byName.get(`${AGENT_CASH_CHECK_JOB}.company`)!.scope).toBe('company');
    expect(byName.get(`${AGENT_CASH_CHECK_JOB}.company`)!.retry.limit).toBe(3);
  });

  it('runs the company check with its alert, and logs only when an owner’s 1070 is below zero', async () => {
    const quiet = harness();
    await quiet.byName
      .get(`${AGENT_CASH_CHECK_JOB}.company`)!
      .handle({ companyId, date: '2026-11-07' }, quiet.ctx);
    expect(quiet.agentCash.check).toHaveBeenCalledWith(companyId, { alert: true });
    expect(quiet.warn).not.toHaveBeenCalled();

    const short = harness([
      { ownerId: '019a3000-0000-7000-8000-0000000000c1', bookId: 'b', heldMinor: -5_000 },
    ]);
    await short.byName
      .get(`${AGENT_CASH_CHECK_JOB}.company`)!
      .handle({ companyId, date: '2026-11-07' }, short.ctx);
    expect(short.agentCash.check).toHaveBeenCalledWith(companyId, { alert: true });
    expect(short.warn).toHaveBeenCalledWith({ owners: 1 }, 'agent cash below zero');
  });

  it('refuses a payload without a company and a date', () => {
    const { byName } = harness();
    const job = byName.get(`${AGENT_CASH_CHECK_JOB}.company`)!;
    expect(job.schema.safeParse({ companyId }).success).toBe(false);
    expect(job.schema.safeParse({ companyId, date: '2026-11-07' }).success).toBe(true);
  });
});
