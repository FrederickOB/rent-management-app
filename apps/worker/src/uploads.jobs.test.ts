import { InMemoryAlert } from '@rent/integrations';
import { createLogger } from '@rent/server/core';
import { UPLOADS_SCAN_JOB } from '@rent/server/documents';
import type { JobContext, JobDefinition } from '@rent/server/jobs';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from './jobs';
import { UPLOADS_EVENT_TYPES, uploadsJobs } from './uploads.jobs';

// M11 decision 6 (plan 4.14): the `uploads.scan` job, keyed by document. The scan itself is
// DocumentsService.scanUpload, proven against the database in m11-uploads-scan.int.test.ts.

const companyId = '019a3000-0000-7000-8000-000000000011';
const documentId = '019a3000-0000-7000-8000-0000000000d1';

function harness(result: unknown) {
  const alerts = new InMemoryAlert();
  const documents = { scanUpload: vi.fn().mockResolvedValue(result) };
  const [job] = uploadsJobs({ alerts, documents } as unknown as WorkerDeps) as JobDefinition<{
    companyId: string;
    documentId: string;
  }>[];
  const ctx: JobContext = {
    jobId: 'job-1',
    logger: createLogger({ level: 'silent' }),
    companyId,
    withCompany: () => Promise.reject(new Error('not used')),
    once: () => Promise.resolve(true),
    enqueue: vi.fn().mockResolvedValue(undefined),
  };
  return { job: job!, alerts, documents, ctx };
}

describe('NFR-SEC the upload scan job (M11 decision 6)', () => {
  it('is a company job the outbox feeds, draining its queue, retried with backoff', () => {
    const { job } = harness(null);
    expect(UPLOADS_EVENT_TYPES).toEqual([UPLOADS_SCAN_JOB]);
    expect(job).toMatchObject({ name: 'uploads.scan', scope: 'company', drain: true });
    expect(job.retry).toMatchObject({ backoff: true });
    expect(job.retry.limit).toBeGreaterThanOrEqual(5);
  });

  it('raises a critical alert with ids only for an infected upload, and none for a clean one', async () => {
    const infected = harness({
      status: 'infected',
      engine: 'clamav',
      kind: 'maintenance_media',
      scanned: true,
    });
    await infected.job.handle({ companyId, documentId }, infected.ctx);
    expect(infected.documents.scanUpload).toHaveBeenCalledWith(companyId, documentId);
    expect(infected.alerts.byCode('uploads.infected')).toEqual([
      expect.objectContaining({
        severity: 'critical',
        context: { companyId, documentId, kind: 'maintenance_media', engine: 'clamav' },
      }),
    ]);
    const clean = harness({ status: 'clean', engine: 'clamav', kind: 'lease_scan', scanned: true });
    await clean.job.handle({ companyId, documentId }, clean.ctx);
    expect(clean.alerts.raised).toEqual([]);
  });

  it('lets a scanner failure through, so the job retries and dead-letters with an alert', async () => {
    const { job, ctx, documents } = harness(null);
    documents.scanUpload.mockRejectedValueOnce(new Error('clamd unreachable'));
    await expect(job.handle({ companyId, documentId }, ctx)).rejects.toThrow('clamd unreachable');
  });
});
