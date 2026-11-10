import { Writable } from 'node:stream';
import { createLogger } from '@rent/server/core';
import {
  DATA_PROTECTION_EXPORT_CLEANUP_JOB,
  DATA_PROTECTION_EXPORT_JOB,
  RETENTION_REVIEW_JOB,
} from '@rent/server/data-protection';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { describe, expect, it, vi } from 'vitest';
import { DATA_PROTECTION_EVENT_TYPES, dataProtectionJobs } from './data-protection.jobs';
import type { WorkerDeps } from './jobs';

const companyId = '019a3000-0000-7000-8000-00000000000d';
const exportId = '019a3000-0000-7000-8000-0000000000e1';

function harness() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  const logger = createLogger({ level: 'trace', destination });
  const dataProtection = {
    prepareExport: vi.fn().mockResolvedValue('ready'),
    failExport: vi.fn().mockResolvedValue(undefined),
    cleanupExports: vi.fn().mockResolvedValue({ deleted: 2 }),
  };
  const retention = {
    run: vi.fn().mockResolvedValue({
      checkedOn: '2026-11-10',
      stored: true,
      categories: [
        {
          category: 'messages',
          ruleKey: 'data_retention.other.messages',
          verified: false,
          years: null,
          pastRetention: 0,
        },
      ],
    }),
  };
  const jobs = dataProtectionJobs({ dataProtection, retention } as unknown as Parameters<
    typeof dataProtectionJobs
  >[0] &
    WorkerDeps);
  const byName = new Map(jobs.map((j) => [j.name, j as JobDefinition<unknown>]));
  const ctx: JobContext = {
    jobId: 'job-1',
    logger,
    companyId,
    withCompany: () => Promise.reject(new Error('not used')),
    once: () => Promise.resolve(true),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
  return { byName, ctx, dataProtection, retention, output: () => lines.join('') };
}

describe('NFR-DP the data protection jobs (M11 decision 5, plan 4.14)', () => {
  it('consumes the export event, and reviews retention nightly as a system job', () => {
    const { byName } = harness();
    expect(DATA_PROTECTION_EVENT_TYPES).toEqual([DATA_PROTECTION_EXPORT_JOB]);
    expect(byName.get(DATA_PROTECTION_EXPORT_JOB)!.scope).toBe('company');
    expect(byName.get(RETENTION_REVIEW_JOB)!.scope).toBe('system');
    expect(byName.get(RETENTION_REVIEW_JOB)!.cron).toBe('15 3 * * *');
  });

  it('★ log redaction: the export job logs its id and outcome, never what the export holds', async () => {
    const h = harness();
    const job = h.byName.get(DATA_PROTECTION_EXPORT_JOB)!;
    expect(job.schema.safeParse({ companyId }).success).toBe(false);
    await job.handle({ companyId, exportId, requestId: exportId }, h.ctx);
    expect(h.dataProtection.prepareExport).toHaveBeenCalledWith(companyId, exportId);
    const logged = JSON.parse(h.output().trim()) as Record<string, unknown>;
    expect(Object.keys(logged).sort()).toEqual([
      'exportId',
      'level',
      'msg',
      'name',
      'outcome',
      'time',
    ]);
    expect(logged).toMatchObject({ exportId, outcome: 'ready' });
  });

  it('marks the export failed, with a code only, after its last retry', async () => {
    const h = harness();
    const job = h.byName.get(DATA_PROTECTION_EXPORT_JOB)!;
    expect(job.retry.limit).toBeGreaterThan(0);
    await job.onDeadLetter!({ companyId, exportId }, { logger: h.ctx.logger });
    expect(h.dataProtection.failExport).toHaveBeenCalledWith(companyId, exportId, 'export_failed');
  });

  it('logs the nightly review’s counts by category, nothing else', async () => {
    const h = harness();
    await h.byName.get(RETENTION_REVIEW_JOB)!.handle({}, h.ctx);
    expect(h.retention.run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.output().trim())).toMatchObject({
      checkedOn: '2026-11-10',
      stored: true,
      pastRetention: { messages: 0 },
    });
  });

  it('B6 deletes exports older than 7 days daily, logging only how many', async () => {
    const h = harness();
    const job = h.byName.get(DATA_PROTECTION_EXPORT_CLEANUP_JOB)!;
    expect(job.scope).toBe('system');
    expect(job.cron).toBe('45 3 * * *');
    await job.handle({}, h.ctx);
    expect(h.dataProtection.cleanupExports).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(h.output().trim()) as Record<string, unknown>;
    expect(logged).toMatchObject({ deleted: 2 });
    expect(Object.keys(logged).sort()).toEqual(['deleted', 'level', 'msg', 'name', 'time']);
  });
});
